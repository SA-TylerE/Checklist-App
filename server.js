const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const https    = require('https');
const http     = require('http');
const crypto   = require('crypto');
const { exec } = require('child_process');

const app        = express();
const PORT       = 3001;
const DATA_FILE  = path.join(__dirname, 'data', 'clients.json');
const CFG_FILE   = path.join(__dirname, 'data', 'config.json');
const LOG_FILE   = path.join(__dirname, 'data', 'logs.json');
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_LOGS   = 5000;

app.use(express.json({ limit: '5mb' }));
app.use('/api/backup-data', express.text({ limit: '10mb' }));
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.use(express.static(PUBLIC_DIR));


// ── SSE ───────────────────────────────────────────────────────────────────────
const sseClients = new Set();

function pushEvent(type, payload, sourceId) {
  const data = `event: ${type}\ndata: ${JSON.stringify({ type, src: sourceId||'', t: Date.now(), ...payload })}\n\n`;
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

// Write to a temp file then rename — prevents partial writes from corrupting JSON if the process crashes mid-write.
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
// Config read — token is NOT returned; client receives syncroTokenSet (bool) only.
app.get('/api/config', (req, res) => {
  try {
    if (!fs.existsSync(CFG_FILE)) return res.status(404).json({ error: 'config.json not found' });
    const cfg = readCfg();
    const token = cfg.syncro_api_token || '';
    res.json({
      syncroTokenSet:  !!token,
      syncroTokenHint: token ? token.slice(0, 5) + '•••••••••••' : '',
      syncroSubdomain: cfg.syncro_subdomain  || '',
      staleDays:       cfg.stale_days        || 14,
      dueWarningDays:  cfg.due_warning_days  || 7,
      orgName:         cfg.org_name          || 'System Alternatives',
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
      // Only update token if a non-empty value is provided
      syncro_api_token: b.syncroToken     || cur.syncro_api_token,
      syncro_subdomain: b.syncroSubdomain ?? cur.syncro_subdomain,
      stale_days:       b.staleDays       ?? cur.stale_days,
      due_warning_days: b.dueWarningDays  ?? cur.due_warning_days,
      org_name:         b.orgName         ?? cur.org_name,
    };
    atomicWrite(CFG_FILE, JSON.stringify(updated, null, 2));
    pushEvent('config-updated', {}, req.headers['x-source-id']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Failed to write config' }); }
});

// Syncro customer search — proxied server-side so the API token never reaches the browser.
app.get('/api/syncro/search', (req, res) => {
  try {
    const cfg = readCfg();
    const token = cfg.syncro_api_token;
    const subdomain = cfg.syncro_subdomain;
    if (!token || !subdomain) return res.status(400).json({ error: 'Syncro not configured' });
    const q = encodeURIComponent(req.query.q || '');
    const options = {
      hostname: `${subdomain}.syncromsp.com`,
      path: `/api/v1/customers?business_name=${q}`,
      headers: { 'accept': 'application/json', 'Authorization': token },
    };
    https.get(options, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try { res.status(apiRes.statusCode).json(JSON.parse(data)); }
        catch(_) { res.status(500).json({ error: 'Invalid response from Syncro' }); }
      });
    }).on('error', e => res.status(500).json({ error: e.message }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Backup data — fetch from URL (with redirect following), optionally AES-256-CBC decrypt
const BACKUP_DATA_FILE = path.join(__dirname, 'data', 'backup-data.txt');

function parseBkTxt(text) {
  const data = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(',');
    if (parts.length < 4) continue;
    const dsMatch = parts[2]?.match(/diskSize=(\d+)/);
    const laMatch = parts[3]?.match(/lastAccess=(\d+)/);
    if (!dsMatch || !laMatch) continue;
    const encMatch = parts[4]?.match(/encrypted=(\d)/);
    const runMatch = parts[5]?.match(/lastRunOk=(-?\d)/);
    const errMatch = parts[6]?.match(/errFiles=(.*)/);
    const errFiles = errMatch && errMatch[1] ? decodeURIComponent(errMatch[1]).split('\n') : null;
    data.push({ client: parts[0], profile: parts[1], diskSize: parseInt(dsMatch[1]), lastAccess: parseInt(laMatch[1]), encrypted: encMatch ? encMatch[1] === '1' : false, lastRunOk: runMatch ? parseInt(runMatch[1]) : -1, errFiles });
  }
  return data;
}

function decryptBkContent(b64, keyStr) {
  const buf       = Buffer.from(b64.trim(), 'base64');
  const iv        = buf.slice(0, 16);
  const encrypted = buf.slice(16);
  const key       = Buffer.alloc(32);
  Buffer.from(keyStr, 'utf8').copy(key);       // pad/truncate to 32 bytes
  const decipher  = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// Fetch a URL and optionally AES-256-CBC decrypt it. Throws an Error with a
// user-facing message on any failure (HTTP error, empty body, bad key, etc).
async function fetchAndDecryptDataset(url, encKey) {
  const { status, text: content } = await fetchUrl(url);
  const trimmed = content.trim();

  if (status !== 200) {
    throw new Error(`URL returned HTTP ${status}. Check the URL is correct and the file is publicly accessible.`);
  }
  if (!trimmed) {
    throw new Error('URL returned empty content. The script may not have run yet or the file may be empty.');
  }
  if (trimmed.startsWith('<') || (trimmed.startsWith('{') && trimmed.includes('"error"'))) {
    const preview = trimmed.slice(0, 200).replace(/\n/g, ' ');
    throw new Error(`URL returned a web page instead of file content. Make sure the URL points directly to the raw file (not a web page). Preview: ${preview}`);
  }

  if (!encKey) return trimmed;

  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length < 17) {
    throw new Error(`URL returned content that is too short to be encrypted data (${buf.length} decoded bytes). The file may be empty or the URL may be wrong. Content starts with: "${trimmed.slice(0, 100)}"`);
  }
  try {
    return decryptBkContent(trimmed, encKey);
  } catch (decErr) {
    const msg = decErr.message || '';
    if (msg.includes('initialization vector') || msg.includes('wrong final block') || msg.includes('bad decrypt')) {
      throw new Error('Decryption failed. The encryption key in Settings does not match the key used in the PowerShell script, or the file content is corrupted. Verify both keys are identical (32 characters).');
    }
    throw new Error(`Decryption error: ${msg}`);
  }
}

function fetchUrl(url, hops = 6) {
  return new Promise((resolve, reject) => {
    const mod    = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const opts   = { hostname: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname + parsed.search, headers: { 'User-Agent': 'Mozilla/5.0' } };
    mod.get(opts, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && hops > 0) {
        const next = res.headers.location.startsWith('http') ? res.headers.location : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        res.resume();
        return resolve(fetchUrl(next, hops - 1));
      }
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}

// ── Direct Syncrify polling (live activity) ───────────────────────────────────
// Replaces the Gist relay for backup-activity when syncrifyHost/syncrifyUser/
// syncrifyPass are configured in Settings: server.js logs into Syncrify itself
// (e.g. over Tailscale) and polls app?operation=activity on a timer.

function syncrifyHttpRequest(baseUrl, pathAndQuery, { method = 'GET', body = null, cookie = null } = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(pathAndQuery, baseUrl);
    const mod     = parsed.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (cookie) headers['Cookie'] = cookie;
    if (body) {
      headers['Content-Type']   = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
      headers['Referer']        = `${parsed.protocol}//${parsed.host}/app`;
      headers['Origin']         = `${parsed.protocol}//${parsed.host}`;
    }
    const opts = { hostname: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname + parsed.search, method, headers };
    const req = mod.request(opts, res => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Merge Set-Cookie response header(s) into an existing "k=v; k2=v2" cookie string.
function mergeCookies(existingCookieStr, setCookieHeaders) {
  const jar = {};
  for (const part of (existingCookieStr || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) jar[k] = rest.join('=');
  }
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : (setCookieHeaders ? [setCookieHeaders] : []);
  for (const sc of arr) {
    const [k, ...rest] = sc.split(';')[0].trim().split('=');
    if (k) jar[k] = rest.join('=');
  }
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function looksLikeSyncrifyLoginPage(html) {
  return /name=["']pwd["']/i.test(html);
}

let _syncrifySession = { cookie: null };

async function ensureSyncrifySession(host, user, pass, forceRelogin = false) {
  if (_syncrifySession.cookie && !forceRelogin) return _syncrifySession.cookie;

  const r1 = await syncrifyHttpRequest(host, '/app');
  let cookie = mergeCookies(null, r1.headers['set-cookie']);

  const body = [
    `uid=${encodeURIComponent(user)}`,
    `pwd=${encodeURIComponent(pass)}`,
    'proceedButton=ok',
    'operation=login',
    'operation2=login',
    `nl=${encodeURIComponent('app?operation=home')}`,
  ].join('&');
  const r2 = await syncrifyHttpRequest(host, '/app', { method: 'POST', body, cookie });
  cookie = mergeCookies(cookie, r2.headers['set-cookie']);

  _syncrifySession.cookie = cookie;
  return cookie;
}

const SYNC_ACTIVITY_ROW_PATTERN = /<tr>\s*<td><a href="([^"]*)"[^>]*title="Connecting from ([\d.]+)[^"]*"[^>]*>[\s\S]*?<\/a>\s*([^<]+)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td><img[^>]*title="([^"]*)"/g;

// Fetches Syncrify's "Active Sessions" table plus per-job detail (st=jdd) for
// each running job. Returns rows shaped like parseActivityCsv()'s output.
async function fetchSyncrifyActivity(host, user, pass) {
  let cookie = await ensureSyncrifySession(host, user, pass);
  let r = await syncrifyHttpRequest(host, '/app?operation=activity', { cookie });
  if (looksLikeSyncrifyLoginPage(r.text)) {
    cookie = await ensureSyncrifySession(host, user, pass, true);
    r = await syncrifyHttpRequest(host, '/app?operation=activity', { cookie });
  }

  const rows = [];
  let m;
  SYNC_ACTIVITY_ROW_PATTERN.lastIndex = 0;
  while ((m = SYNC_ACTIVITY_ROW_PATTERN.exec(r.text))) {
    const href = m[1];
    const row = {
      profile: m[4].trim(), bytes: m[5].trim(), status: m[6].trim(),
      clientIp: m[2].trim(), user: m[3].trim(),
      jobId: null, startedOn: null, filesCompleted: null, filesQueue: null, message: null, percentDone: null,
    };
    const jiMatch = href.match(/ji=(\d+)/);
    if (jiMatch) {
      row.jobId = jiMatch[1];
      try {
        const jr = await syncrifyHttpRequest(host, `/app?operation=activity&st=jdd&ji=${row.jobId}`, { cookie });
        const jh = jr.text;
        let mm;
        if ((mm = jh.match(/Started On:<\/th>\s*<td>([^<]+)<\/td>/)))    row.startedOn      = mm[1].trim();
        if ((mm = jh.match(/Files in Queue:<\/th>\s*<td>(\d+)<\/td>/)))  row.filesQueue     = parseInt(mm[1]);
        if ((mm = jh.match(/Files Completed:<\/th>\s*<td>(\d+)<\/td>/))) row.filesCompleted = parseInt(mm[1]);
        if ((mm = jh.match(/Percent Done:<\/th>\s*<td>(\d+)<\/td>/)))    row.percentDone    = parseInt(mm[1]);
        if ((mm = jh.match(/<h4>Message<\/h4>\s*([^\r\n]+)/)))           row.message        = mm[1].trim();
      } catch (e) {
        console.log(`[syncrify-activity] Failed to fetch job detail for job ${row.jobId}: ${e.message}`);
      }
    }
    rows.push(row);
  }
  return rows;
}

let _liveActivity = { data: [], lastUpdated: null, error: null };

async function pollSyncrifyActivityLoop() {
  const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
  const host = (settings.syncrifyHost || '').trim().replace(/\/+$/, '');
  const user = (settings.syncrifyUser || '').trim();
  const pass = settings.syncrifyPass || '';
  const intervalSec = Math.max(5, parseInt(settings.syncrifyActivityPollSec) || 30);

  if (host && user && pass) {
    try {
      const data = await fetchSyncrifyActivity(host, user, pass);
      _liveActivity = { data, lastUpdated: Date.now(), error: null };
      pushEvent('backup-activity-updated', { data: _liveActivity.data, lastUpdated: _liveActivity.lastUpdated });
    } catch (e) {
      console.log(`[syncrify-activity] Poll failed: ${e.message}`);
      _syncrifySession.cookie = null; // force re-login next attempt
      _liveActivity = { ..._liveActivity, error: e.message };
      pushEvent('backup-activity-updated', { data: _liveActivity.data, lastUpdated: _liveActivity.lastUpdated, error: e.message });
    }
  }
  setTimeout(pollSyncrifyActivityLoop, intervalSec * 1000);
}

app.get('/api/backup-data', async (req, res) => {
  try {
    const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
    const rawUrl   = (settings.backupDataUrl       || '').trim();
    const encKey   = (settings.backupEncryptionKey || '').trim();

    let text;
    if (rawUrl) {
      try {
        text = await fetchAndDecryptDataset(rawUrl, encKey);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
      const existing = fs.existsSync(BACKUP_DATA_FILE) ? fs.readFileSync(BACKUP_DATA_FILE, 'utf8') : null;
      if (existing !== text) atomicWrite(BACKUP_DATA_FILE, text);
    } else if (fs.existsSync(BACKUP_DATA_FILE)) {
      text = fs.readFileSync(BACKUP_DATA_FILE, 'utf8');
    } else {
      return res.json({ data: [], lastUpdated: null });
    }

    const lastUpdated = fs.existsSync(BACKUP_DATA_FILE) ? fs.statSync(BACKUP_DATA_FILE).mtimeMs : null;
    res.json({ data: parseBkTxt(text), lastUpdated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Activity data — currently-active Syncrify sessions (from the authenticated
// app?operation=activity dashboard widget)
const ACTIVITY_DATA_FILE = path.join(__dirname, 'data', 'backup-activity.csv');

function parseActivityCsv(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const data = [];
  for (let i = 1; i < lines.length; i++) { // skip header row
    const f = lines[i].split(',');
    if (f.length < 5) continue;
    data.push({
      profile:        f[0],
      bytes:          f[1],
      status:         f[2],
      clientIp:       f[3],
      user:           f[4],
      jobId:          f[5] || null,
      startedOn:      f[6] || null,
      filesCompleted: f[7] !== undefined && f[7] !== '' ? parseInt(f[7]) : null,
      filesQueue:     f[8] !== undefined && f[8] !== '' ? parseInt(f[8]) : null,
      message:        f[9] ? decodeURIComponent(f[9]) : null,
      percentDone:    f[10] !== undefined && f[10] !== '' ? parseInt(f[10]) : null,
    });
  }
  return data;
}

app.get('/api/backup-activity', async (req, res) => {
  try {
    const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
    const syncrifyConfigured = !!((settings.syncrifyHost || '').trim() && (settings.syncrifyUser || '').trim() && settings.syncrifyPass);

    if (_liveActivity.lastUpdated) {
      return res.json({ data: _liveActivity.data, lastUpdated: _liveActivity.lastUpdated, error: _liveActivity.error || undefined, source: 'direct' });
    }

    const rawUrl   = (settings.backupActivityUrl   || '').trim();
    const encKey   = (settings.backupEncryptionKey || '').trim();

    let text;
    if (rawUrl) {
      try {
        text = await fetchAndDecryptDataset(rawUrl, encKey);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
      const existing = fs.existsSync(ACTIVITY_DATA_FILE) ? fs.readFileSync(ACTIVITY_DATA_FILE, 'utf8') : null;
      if (existing !== text) atomicWrite(ACTIVITY_DATA_FILE, text);
    } else if (fs.existsSync(ACTIVITY_DATA_FILE)) {
      text = fs.readFileSync(ACTIVITY_DATA_FILE, 'utf8');
    } else {
      return res.json({ data: [], lastUpdated: null, source: syncrifyConfigured ? 'direct-pending' : 'none', error: _liveActivity.error || undefined });
    }

    const lastUpdated = fs.existsSync(ACTIVITY_DATA_FILE) ? fs.statSync(ACTIVITY_DATA_FILE).mtimeMs : null;
    res.json({ data: parseActivityCsv(text), lastUpdated, source: syncrifyConfigured ? 'direct-pending' : 'gist', error: syncrifyConfigured ? (_liveActivity.error || undefined) : undefined });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Immediately attempts a Syncrify login + activity fetch using the currently-saved
// settings, bypassing the poll interval. Used by the Settings UI "Test Connection"
// button so users get instant feedback after saving credentials.
app.post('/api/syncrify-test', async (req, res) => {
  try {
    const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
    const host = (settings.syncrifyHost || '').trim().replace(/\/+$/, '');
    const user = (settings.syncrifyUser || '').trim();
    const pass = settings.syncrifyPass || '';
    if (!host || !user || !pass) return res.status(400).json({ ok: false, error: 'Syncrify host, username, and password must be configured first.' });

    _syncrifySession.cookie = null;
    const data = await fetchSyncrifyActivity(host, user, pass);
    _liveActivity = { data, lastUpdated: Date.now(), error: null };
    pushEvent('backup-activity-updated', { data: _liveActivity.data, lastUpdated: _liveActivity.lastUpdated });
    res.json({ ok: true, jobCount: data.length });
  } catch (e) {
    _liveActivity = { ..._liveActivity, error: e.message };
    res.json({ ok: false, error: e.message });
  }
});

// Drive data — total/free space of the backup storage volume (e.g. D:\)
const DRIVE_DATA_FILE = path.join(__dirname, 'data', 'backup-drive.csv');

function parseDriveCsv(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const f = lines[1].split(',');
  if (f.length < 2) return null;
  const totalBytes = parseInt(f[0]);
  const freeBytes  = parseInt(f[1]);
  if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes)) return null;
  return { totalBytes, freeBytes };
}

app.get('/api/backup-drive', async (req, res) => {
  try {
    const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
    const rawUrl   = (settings.backupDriveUrl      || '').trim();
    const encKey   = (settings.backupEncryptionKey || '').trim();

    let text;
    if (rawUrl) {
      try {
        text = await fetchAndDecryptDataset(rawUrl, encKey);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
      const existing = fs.existsSync(DRIVE_DATA_FILE) ? fs.readFileSync(DRIVE_DATA_FILE, 'utf8') : null;
      if (existing !== text) atomicWrite(DRIVE_DATA_FILE, text);
    } else if (fs.existsSync(DRIVE_DATA_FILE)) {
      text = fs.readFileSync(DRIVE_DATA_FILE, 'utf8');
    } else {
      return res.json({ data: null, lastUpdated: null });
    }

    const lastUpdated = fs.existsSync(DRIVE_DATA_FILE) ? fs.statSync(DRIVE_DATA_FILE).mtimeMs : null;
    res.json({ data: parseDriveCsv(text), lastUpdated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// URL shortener proxy — browser can't call is.gd directly due to CORS
app.get('/api/shorten', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  const target = `https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`;
  https.get(target, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      const short = data.trim();
      if (!short || short.startsWith('Error:')) return res.status(400).json({ error: short || 'Shortening failed' });
      res.json({ short });
    });
  }).on('error', e => res.status(500).json({ error: e.message }));
});

// Sales quotes
const SALES_QUOTES_FILE = path.join(__dirname, 'data', 'sales-quotes.json');
app.get('/api/sales-quotes', (req, res) => {
  try {
    if (!fs.existsSync(SALES_QUOTES_FILE)) return res.json({});
    res.json(JSON.parse(fs.readFileSync(SALES_QUOTES_FILE, 'utf8')));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/sales-quotes', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid payload' });
    atomicWrite(SALES_QUOTES_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
const SETTINGS_FILE  = path.join(__dirname, 'data', 'settings.json');
const SECRET_MASK    = '********';
app.get('/api/settings', (req, res) => {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return res.json({ staleDays: 30, dueDays: 3 });
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (settings.syncrifyPass) settings.syncrifyPass = SECRET_MASK;
    res.json(settings);
  } catch(e) { res.json({ staleDays: 30, dueDays: 3 }); }
});
app.put('/api/settings', (req, res) => {
  try {
    const incoming = req.body;
    if (incoming.syncrifyPass === SECRET_MASK) {
      const existing = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
      incoming.syncrifyPass = existing.syncrifyPass || '';
    }
    atomicWrite(SETTINGS_FILE, JSON.stringify(incoming, null, 2));
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

// Logs
function readLogs(){
  try{ return JSON.parse(fs.readFileSync(LOG_FILE,'utf8')); }catch(_){ return []; }
}
app.get('/api/logs',(req,res)=>{
  try{
    let logs=readLogs();
    const {clientId,limit=500}=req.query;
    if(clientId) logs=logs.filter(l=>l.clientId===clientId);
    res.json(logs.slice(0,parseInt(limit)));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/logs',(req,res)=>{
  try{
    let logs=readLogs();
    const entry={...req.body,id:Date.now()+'-'+Math.random().toString(36).slice(2,6)};
    logs.unshift(entry);
    if(logs.length>MAX_LOGS) logs=logs.slice(0,MAX_LOGS);
    atomicWrite(LOG_FILE,JSON.stringify(logs));
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// Update checker
// -c safe.directory bypasses Git's ownership check when the process user differs from the repo owner.
const gitSafe = `git -c safe.directory=${__dirname}`;
const svcUser = os.userInfo().username;

function gitHint(stderr) {
  if (!stderr) return null;
  if (stderr.includes('Permission denied') || stderr.includes('cannot open') || stderr.includes('unable to write'))
    return `Fix ownership: sudo chown -R ${svcUser} ${__dirname}`;
  if (stderr.includes('Authentication failed') || stderr.includes('could not read Username') || stderr.includes('invalid credentials'))
    return 'Git authentication failed. Ensure the remote URL embeds a token (HTTPS) or the service user has an SSH key configured.';
  if (stderr.includes('Could not resolve host') || stderr.includes('unable to connect'))
    return 'Cannot reach GitHub. Check network/firewall from the server.';
  return null;
}

app.get('/api/update/status', (req, res) => {
  // Use ls-remote (read-only, no writes to .git) then compare with local HEAD
  exec(`${gitSafe} rev-parse HEAD`, { cwd: __dirname }, (e1, localOut, se1) => {
    if (e1) return res.json({ error: se1 || e1.message, hint: gitHint(se1 || e1.message), commits: [] });
    exec(`${gitSafe} ls-remote origin HEAD`, { cwd: __dirname }, (e2, remoteOut, se2) => {
      if (e2) return res.json({ error: se2 || e2.message, hint: gitHint(se2 || e2.message), commits: [] });
      const local  = localOut.trim();
      const remote = remoteOut.trim().split(/\s+/)[0] || '';
      if (!remote) return res.json({ error: 'Could not read remote HEAD — is origin configured?', commits: [] });
      if (local === remote) return res.json({ upToDate: true, commits: [] });
      res.json({ upToDate: false, commits: [`Remote is ahead (${remote.slice(0,7)} vs local ${local.slice(0,7)})`] });
    });
  });
});

app.post('/api/update', (req, res) => {
  exec('sudo /usr/local/bin/checklist-git-pull', (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message, hint: gitHint(stderr || err.message) });
    res.json({ ok: true, output: stdout });
    pushEvent('app-updated', {}, 'server');
    setTimeout(() => process.exit(0), 800);
  });
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

pollSyncrifyActivityLoop();
