const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const app        = express();
const PORT       = 3001;
const DATA_FILE  = path.join(__dirname, 'data', 'clients.json');
const CFG_FILE   = path.join(__dirname, 'data', 'config.json');
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));

// ── SSE ───────────────────────────────────────────────────────────────────────
const sseClients = new Set();

function pushEvent(type, payload, sourceId) {
  const data = `data: ${JSON.stringify({ type, src: sourceId||'', t: Date.now(), ...payload })}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch(_) { sseClients.delete(res); }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
function ensureDirs() {
  [path.join(__dirname,'data'), BACKUP_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}');
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); }
  catch(_) { return {}; }
}

function doBackup(label) {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const stamp = label || new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const dest  = path.join(BACKUP_DIR, `clients-${stamp}.json`);
    fs.copyFileSync(DATA_FILE, dest);
    // Prune to last 30
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('clients-') && f.endsWith('.json'))
      .sort();
    while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    return path.basename(dest);
  } catch(e) { console.error('Backup error:', e.message); return null; }
}

ensureDirs();
// Daily startup backup
const todayStamp = new Date().toISOString().slice(0,10);
if (!fs.readdirSync(BACKUP_DIR).some(f => f.includes(todayStamp))) doBackup(todayStamp);

// ── Routes ────────────────────────────────────────────────────────────────────
// Config read
app.get('/api/config', (req, res) => {
  try {
    if (!fs.existsSync(CFG_FILE)) return res.status(404).json({ error: 'config.json not found' });
    const cfg = readCfg();
    res.json({
      syncroToken:     cfg.syncro_api_token  || '',
      syncroSubdomain: cfg.syncro_subdomain  || '',
      staleDays:       cfg.stale_days        || 14,
      dueWarningDays:  cfg.due_warning_days   || 7,
    });
  } catch(e) { res.status(500).json({ error: 'Failed to read config' }); }
});

// Config write
app.put('/api/config', (req, res) => {
  try {
    const cur = readCfg();
    const b   = req.body || {};
    const updated = {
      ...cur,
      syncro_api_token: b.syncroToken     ?? cur.syncro_api_token,
      syncro_subdomain: b.syncroSubdomain ?? cur.syncro_subdomain,
      stale_days:       b.staleDays       ?? cur.stale_days,
      due_warning_days: b.dueWarningDays   ?? cur.due_warning_days,
    };
    atomicWrite(CFG_FILE, JSON.stringify(updated, null, 2));
    pushEvent('config-updated', {}, req.headers['x-source-id']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Failed to write config' }); }
});

// Clients read/write
app.get('/api/clients', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
  catch(e) { res.status(500).json({ error: 'Failed to read client data' }); }
});

app.put('/api/clients', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid payload' });
    atomicWrite(DATA_FILE, JSON.stringify(req.body, null, 2));
    const sessionId = req.headers['x-session-id'] || req.headers['x-source-id'] || '';
    const techName  = req.headers['x-tech-name'] || '';
    pushEvent('clients-updated', { clients: req.body, sessionId, techName }, sessionId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Failed to write client data' }); }
});

// Steps/guides write (for future editor)
app.put('/api/steps', (req, res) => {
  try {
    atomicWrite(path.join(PUBLIC_DIR,'steps.json'), JSON.stringify(req.body,null,2));
    pushEvent('steps-updated', {}, req.headers['x-source-id']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/guides', (req, res) => {
  try {
    atomicWrite(path.join(PUBLIC_DIR,'guides.json'), JSON.stringify(req.body,null,2));
    pushEvent('guides-updated', {}, req.headers['x-source-id']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Settings
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
app.get('/api/settings', (req, res) => {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return res.json({ staleDays: 30, dueDays: 3 });
    res.json(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch(e) { res.json({ staleDays: 30, dueDays: 3 }); }
});
app.put('/api/settings', (req, res) => {
  try {
    atomicWrite(SETTINGS_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Backups
app.get('/api/backups', (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('clients-') && f.endsWith('.json'))
      .sort().reverse()
      .map(f => ({
        name: f,
        size: fs.statSync(path.join(BACKUP_DIR,f)).size,
        mtime: fs.statSync(path.join(BACKUP_DIR,f)).mtime,
      }));
    res.json(files);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backups', (req, res) => {
  const name = doBackup();
  if (name) res.json({ ok: true, name });
  else res.status(500).json({ error: 'Backup failed' });
});

app.get('/api/backups/download', (req, res) => {
  // Download latest or specific file
  try {
    const file = req.query.file || fs.readdirSync(BACKUP_DIR)
      .filter(f=>f.startsWith('clients-')&&f.endsWith('.json')).sort().reverse()[0];
    if (!file) return res.status(404).json({ error: 'No backups found' });
    const fp = path.join(BACKUP_DIR, path.basename(file)); // basename prevents path traversal
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
    res.download(fp, file);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// SSE
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch(_) { clearInterval(hb); } }, 25000);
  sseClients.add(res);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

// Health
app.get('/api/health', (req, res) => {
  let fileSize=0;
  try { fileSize=fs.statSync(DATA_FILE).size; } catch(_){}
  res.json({
    status:'ok', uptime:Math.round(process.uptime()),
    dataFileSizeKB:Math.round(fileSize/1024),
    sseClients:sseClients.size,
    nodeVersion:process.version, platform:os.platform(),
  });
});

app.listen(PORT, '127.0.0.1', () => console.log(`Checklist API on 127.0.0.1:${PORT}`));
