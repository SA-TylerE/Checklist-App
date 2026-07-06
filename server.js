const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const https    = require('https');
const http     = require('http');
const { exec } = require('child_process');
const { createDb, kvGet, kvSet } = require('./db');
const { migrate } = require('./scripts/migrate-json-to-sqlite');
const { renderDocumentPdf, pdfBufferFromDoc } = require('./pdf');

const app        = express();
const PORT       = process.env.PORT || 3001;
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE    = path.join(DATA_DIR, 'app.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_LOGS   = 5000;

app.use(express.json({ limit: '5mb' }));
app.get(['/', '/index.html', '/app.js', '/styles.css'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  const file = req.path === '/' ? 'index.html' : req.path.slice(1);
  res.sendFile(path.join(PUBLIC_DIR, file));
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
  [DATA_DIR, BACKUP_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// Write to a temp file then rename — prevents partial writes from corrupting JSON if the process crashes mid-write.
// (Still used for the public/steps.json editor route — data-file persistence below uses SQLite instead.)
function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

ensureDirs();
migrate(DATA_DIR); // idempotent — no-ops once data/app.db already has migrated data
const db = createDb(DATA_DIR);

function readCfg() {
  return kvGet(db, 'config', {});
}

function readSettings() {
  return kvGet(db, 'settings', {});
}

function readClients() {
  const rows = db.prepare('SELECT id, data FROM clients').all();
  const out = {};
  for (const row of rows) out[row.id] = JSON.parse(row.data);
  return out;
}

function replaceClients(obj) {
  const now = Date.now();
  db.transaction((data) => {
    db.prepare('DELETE FROM clients').run();
    const insert = db.prepare('INSERT INTO clients (id, data, updated_at) VALUES (?, ?, ?)');
    for (const [id, value] of Object.entries(data)) insert.run(id, JSON.stringify(value), now);
  })(obj);
}

function readContracts() {
  const rows = db.prepare('SELECT id, data FROM contracts').all();
  const out = {};
  for (const row of rows) out[row.id] = JSON.parse(row.data);
  return out;
}

function replaceContracts(obj) {
  const now = Date.now();
  db.transaction((data) => {
    db.prepare('DELETE FROM contracts').run();
    const insert = db.prepare('INSERT INTO contracts (id, data, updated_at) VALUES (?, ?, ?)');
    for (const [id, value] of Object.entries(data)) insert.run(id, JSON.stringify(value), now);
  })(obj);
}

async function doBackup(label) {
  try {
    const stamp = label || new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const dest  = path.join(BACKUP_DIR, `app-${stamp}.db`);
    await db.backup(dest);
    // Prune to last 30
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('app-') && f.endsWith('.db'))
      .sort();
    while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    return path.basename(dest);
  } catch(e) { console.error('Backup error:', e.message); return null; }
}

// Daily startup backup
const todayStamp = new Date().toISOString().slice(0,10);
if (!fs.readdirSync(BACKUP_DIR).some(f => f.includes(todayStamp))) doBackup(todayStamp).catch(()=>{});

// ── Routes ────────────────────────────────────────────────────────────────────
// Config read — token is NOT returned; client receives syncroTokenSet (bool) only.
app.get('/api/config', (req, res) => {
  try {
    const cfg = kvGet(db, 'config', null);
    if (!cfg) return res.status(404).json({ error: 'config not found' });
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
    kvSet(db, 'config', updated);
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

// ── Syncro customer cache (Quotes page client picker) ──────────────────────────
// Periodically pulls the full Syncro customer list into syncro_customers so the
// client picker can search a local table instantly instead of hitting Syncro's
// API on every keystroke — same "poll on a timer, cache locally" shape as the
// Syncrify backup-data loop further down.
async function fetchAllSyncroCustomers(subdomain, token) {
  const customers = [];
  let page = 1;
  for (;;) {
    const result = await jsonHttpRequest(`https://${subdomain}.syncromsp.com/api/v1/customers?page=${page}`, {
      method: 'GET',
      headers: { accept: 'application/json', Authorization: token },
    });
    if (result.status !== 200 || !result.json) break;
    const pageCustomers = result.json.customers || [];
    customers.push(...pageCustomers);
    const totalPages = result.json.meta?.total_pages || 1;
    if (page >= totalPages || pageCustomers.length === 0) break;
    page++;
  }
  return customers;
}

function replaceSyncroCustomers(customers) {
  const now = Date.now();
  db.transaction((list) => {
    db.prepare('DELETE FROM syncro_customers').run();
    const insert = db.prepare('INSERT INTO syncro_customers (id, business_name, email, phone, data, updated_at) VALUES (?,?,?,?,?,?)');
    for (const c of list) {
      insert.run(String(c.id), c.business_name || '', c.email || '', c.phone || '', JSON.stringify(c), now);
    }
  })(customers);
}

async function pollSyncroCustomersOnce() {
  try {
    const cfg = readCfg();
    const token = cfg.syncro_api_token;
    const subdomain = cfg.syncro_subdomain;
    if (!token || !subdomain) return { ok: false, error: 'Syncro not configured' };
    const customers = await fetchAllSyncroCustomers(subdomain, token);
    replaceSyncroCustomers(customers);
    return { ok: true, count: customers.length };
  } catch (e) {
    console.log(`[syncro-customers] Poll failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

function pollSyncroCustomersLoop() {
  pollSyncroCustomersOnce().finally(() => {
    const settings    = readSettings();
    const intervalSec = Math.max(300, parseInt(settings.syncroCustomerPollSec) || 1800);
    setTimeout(pollSyncroCustomersLoop, intervalSec * 1000);
  });
}

app.get('/api/syncro-customers', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const rows = q
      ? db.prepare('SELECT id, business_name, email, phone FROM syncro_customers WHERE business_name LIKE ? ORDER BY business_name LIMIT 25').all(`%${q}%`)
      : db.prepare('SELECT id, business_name, email, phone FROM syncro_customers ORDER BY business_name LIMIT 25').all();
    res.json(rows.map(r => ({ id: r.id, businessName: r.business_name, email: r.email, phone: r.phone })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/syncro-customers/refresh', async (req, res) => {
  const result = await pollSyncroCustomersOnce();
  if (result.ok) { pushEvent('syncro-customers-updated', { count: result.count }, req.headers['x-source-id']); res.json(result); }
  else res.status(400).json(result);
});

// ── Direct Syncrify polling (live activity) ───────────────────────────────────
// server.js logs into Syncrify itself (e.g. over Tailscale) using
// syncrifyHost/syncrifyUser/syncrifyPass configured in Settings, and polls
// app?operation=activity on a timer.

function syncrifyHttpRequest(baseUrl, pathAndQuery, { method = 'GET', body = null, cookie = null, timeoutMs = 30000 } = {}) {
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
      // Guard against a response that starts but then stalls mid-stream.
      const stallTimer = setTimeout(() => req.destroy(new Error('Response stalled')), timeoutMs);
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => { clearTimeout(stallTimer); resolve({ status: res.statusCode, headers: res.headers, text }); });
    });
    // Guard against the server never responding at all (connect hangs, or request never acknowledged).
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Generic JSON-over-HTTPS request used to talk to systemalternatives.net's
// approval API (SA-Website) — same timeout-guarded Promise shape as
// syncrifyHttpRequest above, but with JSON headers instead of Syncrify's
// form-encoded/scrape-specific ones.
function jsonHttpRequest(url, { method = 'GET', body = null, headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const reqHeaders = { 'Content-Type': 'application/json', ...headers };
    if (bodyStr) reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
    const opts = { hostname: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname + parsed.search, method, headers: reqHeaders };
    const req = mod.request(opts, res => {
      const stallTimer = setTimeout(() => req.destroy(new Error('Response stalled')), timeoutMs);
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => {
        clearTimeout(stallTimer);
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
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

// Converts a Syncrify size string (e.g. "1.5 GB", "500 MB") to a byte count.
function convertSizeToBytes(str) {
  const m = (str || '').trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB|PB)$/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 }[m[2].toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

// Parses Syncrify's "M/d/yy h:mm tt" date format (e.g. "6/11/26 1:00 AM") to epoch ms.
function parseSyncrifyDateToMs(str) {
  const m = (str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return 0;
  let [, mo, da, yr, hh, mi, ap] = m;
  yr = parseInt(yr); if (yr < 100) yr += 2000;
  hh = parseInt(hh);
  if (ap) { ap = ap.toUpperCase(); if (ap === 'PM' && hh !== 12) hh += 12; if (ap === 'AM' && hh === 12) hh = 0; }
  return new Date(yr, parseInt(mo) - 1, parseInt(da), hh, parseInt(mi)).getTime();
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

const SYNC_PROFILE_ROW_PATTERN  = /<tr>\s*<td>([^<]+)<\/td>\s*<td>\s*<a[^>]*data-content="[\s\S]*?"[^>]*>([\d.]+\s*\w+)<\/a>[\s\S]*?<\/td>\s*<td>([^<]+)<\/td>\s*<td>(Yes|No)<\/td>/g;
const SYNC_REPORT_ROW_PATTERN   = /<tr>\s*<td><img[^>]*itle="Host:[^"]*"[^>]*>\s*([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<!--\s*Author @Blake Start\s*-->([\s\S]*?)<!--\s*@Blake End\s*-->\s*<td>(\d+)<\/td>\s*<\/tr>/g;
const SYNC_ERR_FILES_PATTERN    = /<h3>[^<]*<\/h3>([\s\S]*?)<\/div>/;
const SYNC_EMAIL_PATTERN        = /<abbr title='Name:[^']*'>([^<]+)<\/abbr>/g;
const SYNC_REPO_PATTERN         = /st=mrp[^"]*"[^>]*>(?:<i[^>]*>[^<]*<\/i>\s*)?<\/a>\s*(D:\\[^<]+)/g;

// Fetches per-client backup data from Syncrify's manageUsers pages: disk usage,
// encryption flag, and last-access time per profile (from each user's profile
// page), plus the most recent run status and any failed-files list (from the
// "Report By User" job history). Returns rows shaped like parseBkTxt()'s output.
async function fetchSyncrifyBackupData(host, user, pass) {
  let cookie = await ensureSyncrifySession(host, user, pass);
  let r = await syncrifyHttpRequest(host, '/app?operation=manageUsers', { cookie });
  if (looksLikeSyncrifyLoginPage(r.text)) {
    cookie = await ensureSyncrifySession(host, user, pass, true);
    r = await syncrifyHttpRequest(host, '/app?operation=manageUsers', { cookie });
  }
  const html = r.text;

  const emailMatches = [...html.matchAll(SYNC_EMAIL_PATTERN)];
  const repoMatches  = [...html.matchAll(SYNC_REPO_PATTERN)];

  const rows = [];
  for (let i = 0; i < emailMatches.length; i++) {
    const email = emailMatches[i][1].trim();
    if (!repoMatches[i]) {
      console.log(`[backup-data] No repo path for email #${i} (${email}) - skipping.`);
      continue;
    }
    const clientId = repoMatches[i][1].trim().replace(/^D:\\/, '');

    try {
      const profileR = await syncrifyHttpRequest(host, `/app?operation=manageUsers&st=viewProfile&email=${encodeURIComponent(email)}`, { cookie });
      const profileMatches = [...profileR.text.matchAll(SYNC_PROFILE_ROW_PATTERN)];

      // "Report By User" job history (newest-first) -> last run status + error-file ref per profile
      const lastRunStatus = {};
      const lastRunErrf = {};
      try {
        const reportBody = `operation=reports&drbu=1&uid=${encodeURIComponent(email)}`;
        const reportR = await syncrifyHttpRequest(host, '/app', { method: 'POST', body: reportBody, cookie });
        for (const rm of reportR.text.matchAll(SYNC_REPORT_ROW_PATTERN)) {
          const rProfile = rm[1].trim();
          if (Object.prototype.hasOwnProperty.call(lastRunStatus, rProfile)) continue; // first hit = most recent
          const statusCell = rm[4];
          if (/fa-check/.test(statusCell)) {
            lastRunStatus[rProfile] = 1;
          } else if (/fa-times/.test(statusCell)) {
            lastRunStatus[rProfile] = 0;
            const errfMatch = statusCell.match(/errf=([^&"]+)/);
            if (errfMatch) lastRunErrf[rProfile] = errfMatch[1];
          }
        }
      } catch (e) {
        console.log(`[backup-data] Failed to fetch report history for ${clientId}: ${e.message}`);
      }

      // Failed-files list for any profile whose last run errored
      const lastRunErrFiles = {};
      for (const [pName, errf] of Object.entries(lastRunErrf)) {
        try {
          const errUrl = `/app?operation=reports&errf=${encodeURIComponent(errf)}&profile=${encodeURIComponent(pName)}&uid=${encodeURIComponent(email)}`;
          const errR = await syncrifyHttpRequest(host, errUrl, { cookie });
          const errMatch = errR.text.match(SYNC_ERR_FILES_PATTERN);
          if (errMatch) {
            let lines = errMatch[1].split('<br>').map(s => s.trim()).filter(Boolean);
            if (lines.length > 0) {
              const maxLines = 25;
              if (lines.length > maxLines) {
                const total = lines.length;
                lines = lines.slice(0, maxLines);
                lines.push(`...and ${total - maxLines} more`);
              }
              lastRunErrFiles[pName] = lines;
            }
          }
        } catch (e) {
          console.log(`[backup-data] Failed to fetch error report for ${clientId}/${pName}: ${e.message}`);
        }
      }

      for (const m of profileMatches) {
        const profileName = m[1].trim();
        rows.push({
          client: clientId,
          profile: profileName,
          diskSize: convertSizeToBytes(m[2].trim()),
          lastAccess: parseSyncrifyDateToMs(m[3].trim()),
          encrypted: m[4].trim() === 'Yes',
          lastRunOk: Object.prototype.hasOwnProperty.call(lastRunStatus, profileName) ? lastRunStatus[profileName] : -1,
          errFiles: lastRunErrFiles[profileName] || null,
        });
      }
    } catch (e) {
      console.log(`[backup-data] Failed to fetch profile for ${clientId} (${email}): ${e.message}`);
    }
  }
  return rows;
}

// Matches the "Disk Status for D:\" panel on the main app dashboard, e.g.:
//   <th>Total Disk Space:</th><td>139724.95 GB</td> ... <th>Free Space:</th><td>40140.79 GB</td>
const SYNC_DRIVE_PATTERN = /<legend>Disk Status for [^<]*<\/legend>[\s\S]*?<th>Total Disk Space:<\/th>\s*<td>([^<]+)<\/td>[\s\S]*?<th>Free Space:<\/th>\s*<td>([^<]+)<\/td>/;

// Fetches total/free space of the backup storage volume from the main Syncrify
// dashboard (app?operation=home). Returns { totalBytes, freeBytes } or null if
// the page doesn't contain a recognizable Disk Status panel.
async function fetchSyncrifyDriveData(host, user, pass) {
  let cookie = await ensureSyncrifySession(host, user, pass);
  let r = await syncrifyHttpRequest(host, '/app?operation=home', { cookie });
  if (looksLikeSyncrifyLoginPage(r.text)) {
    cookie = await ensureSyncrifySession(host, user, pass, true);
    r = await syncrifyHttpRequest(host, '/app?operation=home', { cookie });
  }
  const m = r.text.match(SYNC_DRIVE_PATTERN);
  if (!m) return null;
  const totalBytes = convertSizeToBytes(m[1].trim());
  const freeBytes  = convertSizeToBytes(m[2].trim());
  if (!totalBytes || !freeBytes) return null;
  return { totalBytes, freeBytes };
}

let _liveActivity = { data: [], lastUpdated: null, error: null };

async function pollSyncrifyActivityLoop() {
  const settings = readSettings();
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

let _liveBackupData = { data: [], lastUpdated: null, error: null };
let _liveDriveData  = { data: null, lastUpdated: null, error: null };

// Persists _liveBackupData/_liveDriveData to disk so they survive a server
// restart instead of sitting empty until the next poll completes.
function loadLiveCache() {
  try {
    const cached = kvGet(db, 'live_backup_cache', null);
    if (!cached) return;
    if (cached.backupData?.lastUpdated) _liveBackupData = { data: cached.backupData.data || [], lastUpdated: cached.backupData.lastUpdated, error: null };
    if (cached.driveData?.lastUpdated)  _liveDriveData  = { data: cached.driveData.data || null, lastUpdated: cached.driveData.lastUpdated, error: null };
  } catch (_) {}
}

function saveLiveCache() {
  try {
    kvSet(db, 'live_backup_cache', {
      backupData: { data: _liveBackupData.data, lastUpdated: _liveBackupData.lastUpdated },
      driveData:  { data: _liveDriveData.data, lastUpdated: _liveDriveData.lastUpdated },
    });
  } catch (_) {}
}

async function pollSyncrifyDataLoop() {
  const settings = readSettings();
  const host = (settings.syncrifyHost || '').trim().replace(/\/+$/, '');
  const user = (settings.syncrifyUser || '').trim();
  const pass = settings.syncrifyPass || '';
  const intervalSec = Math.max(300, parseInt(settings.syncrifyDataPollSec) || 1800);

  if (host && user && pass) {
    try {
      const data = await fetchSyncrifyBackupData(host, user, pass);
      if (data.length > 0) {
        _liveBackupData = { data, lastUpdated: Date.now(), error: null };
        pushEvent('backup-data-updated', { data: _liveBackupData.data, lastUpdated: _liveBackupData.lastUpdated });
      } else {
        console.log('[backup-data] Poll returned no rows - keeping previous data.');
        _liveBackupData = { ..._liveBackupData, error: 'Last poll returned no rows' };
      }
    } catch (e) {
      console.log(`[backup-data] Poll failed: ${e.message}`);
      _syncrifySession.cookie = null; // force re-login next attempt
      _liveBackupData = { ..._liveBackupData, error: e.message };
    }

    try {
      const drive = await fetchSyncrifyDriveData(host, user, pass);
      if (drive) {
        _liveDriveData = { data: drive, lastUpdated: Date.now(), error: null };
        pushEvent('backup-drive-updated', { data: _liveDriveData.data, lastUpdated: _liveDriveData.lastUpdated });
      } else {
        console.log('[backup-drive] Poll did not find a Disk Status panel - keeping previous data.');
        _liveDriveData = { ..._liveDriveData, error: 'Could not find disk status on Syncrify dashboard' };
      }
    } catch (e) {
      console.log(`[backup-drive] Poll failed: ${e.message}`);
      _syncrifySession.cookie = null; // force re-login next attempt
      _liveDriveData = { ..._liveDriveData, error: e.message };
    }

    saveLiveCache();
  }
  setTimeout(pollSyncrifyDataLoop, intervalSec * 1000);
}

// Per-client backup data (disk usage, last-run status, error files), polled
// directly from Syncrify by pollSyncrifyDataLoop().
app.get('/api/backup-data', async (req, res) => {
  try {
    if (_liveBackupData.lastUpdated) {
      return res.json({ data: _liveBackupData.data, lastUpdated: _liveBackupData.lastUpdated, error: _liveBackupData.error || undefined, source: 'direct' });
    }
    const settings = readSettings();
    const syncrifyConfigured = !!((settings.syncrifyHost || '').trim() && (settings.syncrifyUser || '').trim() && settings.syncrifyPass);
    res.json({ data: [], lastUpdated: null, source: syncrifyConfigured ? 'direct-pending' : 'none', error: _liveBackupData.error || undefined });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Currently-active Syncrify sessions, polled directly from Syncrify by
// pollSyncrifyActivityLoop().
app.get('/api/backup-activity', async (req, res) => {
  try {
    if (_liveActivity.lastUpdated) {
      return res.json({ data: _liveActivity.data, lastUpdated: _liveActivity.lastUpdated, error: _liveActivity.error || undefined, source: 'direct' });
    }
    const settings = readSettings();
    const syncrifyConfigured = !!((settings.syncrifyHost || '').trim() && (settings.syncrifyUser || '').trim() && settings.syncrifyPass);
    res.json({ data: [], lastUpdated: null, source: syncrifyConfigured ? 'direct-pending' : 'none', error: _liveActivity.error || undefined });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Immediately attempts a Syncrify login + activity fetch using the currently-saved
// settings, bypassing the poll interval. Used by the Settings UI "Test Connection"
// button so users get instant feedback after saving credentials.
// ?type=data instead fetches per-client backup data (manageUsers scrape) - this is
// slower (one request per client/profile) so it's used by a separate "Test Data Fetch" button.
app.post('/api/syncrify-test', async (req, res) => {
  try {
    const settings = readSettings();
    const host = (settings.syncrifyHost || '').trim().replace(/\/+$/, '');
    const user = (settings.syncrifyUser || '').trim();
    const pass = settings.syncrifyPass || '';
    if (!host || !user || !pass) return res.status(400).json({ ok: false, error: 'Syncrify host, username, and password must be configured first.' });

    _syncrifySession.cookie = null;

    if (req.query.type === 'data') {
      const data = await fetchSyncrifyBackupData(host, user, pass);
      if (data.length > 0) {
        _liveBackupData = { data, lastUpdated: Date.now(), error: null };
        pushEvent('backup-data-updated', { data: _liveBackupData.data, lastUpdated: _liveBackupData.lastUpdated });
        saveLiveCache();
      } else {
        _liveBackupData = { ..._liveBackupData, error: 'Fetch succeeded but returned no rows' };
      }
      return res.json({ ok: data.length > 0, rowCount: data.length });
    }

    const data = await fetchSyncrifyActivity(host, user, pass);
    _liveActivity = { data, lastUpdated: Date.now(), error: null };
    pushEvent('backup-activity-updated', { data: _liveActivity.data, lastUpdated: _liveActivity.lastUpdated });
    res.json({ ok: true, jobCount: data.length });
  } catch (e) {
    if (req.query.type === 'data') _liveBackupData = { ..._liveBackupData, error: e.message };
    else _liveActivity = { ..._liveActivity, error: e.message };
    res.json({ ok: false, error: e.message });
  }
});

// General-purpose Syncrify diagnostics. Three modes:
//  - (no params)   : status summary — config, live-poll state, session state.
//  - ?login=1      : step-by-step login-flow diagnostic (status/cookies/page-type
//                    at each step), for diagnosing auth failures.
//                    ?raw=initial|login|activity returns the raw HTML of that step.
//  - ?path=<page>  : fetch any authenticated Syncrify page (e.g.
//                    "app?operation=manageUsers") and return its raw HTML, using
//                    the cached session (re-logging in if needed). Handy for
//                    inspecting page structure when porting new scrapers.
app.get('/api/syncrify-debug', async (req, res) => {
  try {
    const settings = readSettings();
    const host = (settings.syncrifyHost || '').trim().replace(/\/+$/, '');
    const user = (settings.syncrifyUser || '').trim();
    const pass = settings.syncrifyPass || '';
    if (!host || !user || !pass) return res.status(400).send('Syncrify host, username, and password must be configured first.');

    if (req.query.path) {
      const p = '/' + String(req.query.path).replace(/^\/+/, '');
      let cookie = await ensureSyncrifySession(host, user, pass);
      let r = await syncrifyHttpRequest(host, p, { cookie });
      if (looksLikeSyncrifyLoginPage(r.text)) {
        cookie = await ensureSyncrifySession(host, user, pass, true);
        r = await syncrifyHttpRequest(host, p, { cookie });
      }
      res.set('Content-Type', 'text/plain; charset=utf-8');
      return res.send(r.text);
    }

    if (req.query.login) {
      const r1 = await syncrifyHttpRequest(host, '/app');
      let cookie = mergeCookies(null, r1.headers['set-cookie']);

      const body = [
        `uid=${encodeURIComponent(user)}`,
        `pwd=${encodeURIComponent(pass)}`,
        'proceedButton=ok',
        'operation=login',
        'operation2=login',
        `nl=${encodeURIComponent('app?operation=activity')}`,
      ].join('&');
      const r2 = await syncrifyHttpRequest(host, '/app', { method: 'POST', body, cookie });
      cookie = mergeCookies(cookie, r2.headers['set-cookie']);

      const r3 = await syncrifyHttpRequest(host, '/app?operation=activity', { cookie });

      if (req.query.raw === 'initial')  { res.set('Content-Type', 'text/plain; charset=utf-8'); return res.send(r1.text); }
      if (req.query.raw === 'login')    { res.set('Content-Type', 'text/plain; charset=utf-8'); return res.send(r2.text); }
      if (req.query.raw === 'activity') { res.set('Content-Type', 'text/plain; charset=utf-8'); return res.send(r3.text); }

      _syncrifySession.cookie = cookie;
      return res.json({
        step1_initial:  { status: r1.status, setCookie: r1.headers['set-cookie'] || null, isLoginPage: looksLikeSyncrifyLoginPage(r1.text), bodyLength: r1.text.length },
        step2_login:    { status: r2.status, setCookie: r2.headers['set-cookie'] || null, location: r2.headers['location'] || null, isLoginPage: looksLikeSyncrifyLoginPage(r2.text), bodyLength: r2.text.length },
        step3_activity: { status: r3.status, isLoginPage: looksLikeSyncrifyLoginPage(r3.text), hasActiveSessionsTable: /Active Sessions/i.test(r3.text), bodyLength: r3.text.length },
        cookieSent: cookie,
      });
    }

    res.json({
      syncrifyHost: host,
      syncrifyUser: user,
      activityPollSec: Math.max(5, parseInt(settings.syncrifyActivityPollSec) || 30),
      dataPollSec: Math.max(300, parseInt(settings.syncrifyDataPollSec) || 1800),
      sessionActive: !!_syncrifySession.cookie,
      liveActivity: {
        lastUpdated: _liveActivity.lastUpdated,
        lastUpdatedAgoSec: _liveActivity.lastUpdated ? Math.round((Date.now() - _liveActivity.lastUpdated) / 1000) : null,
        jobCount: _liveActivity.data.length,
        error: _liveActivity.error || null,
      },
      liveBackupData: {
        lastUpdated: _liveBackupData.lastUpdated,
        lastUpdatedAgoSec: _liveBackupData.lastUpdated ? Math.round((Date.now() - _liveBackupData.lastUpdated) / 1000) : null,
        rowCount: _liveBackupData.data.length,
        error: _liveBackupData.error || null,
      },
      hint: 'Use ?login=1 for a step-by-step login diagnostic (add &raw=initial|login|activity for raw HTML), or ?path=app%3Foperation%3DmanageUsers to fetch any authenticated page raw.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Total/free space of the backup storage volume (e.g. D:\), polled directly
// from Syncrify's main dashboard by pollSyncrifyDataLoop().
app.get('/api/backup-drive', async (req, res) => {
  try {
    if (_liveDriveData.lastUpdated) {
      return res.json({ data: _liveDriveData.data, lastUpdated: _liveDriveData.lastUpdated, error: _liveDriveData.error || undefined, source: 'direct' });
    }
    const settings = readSettings();
    const syncrifyConfigured = !!((settings.syncrifyHost || '').trim() && (settings.syncrifyUser || '').trim() && settings.syncrifyPass);
    res.json({ data: null, lastUpdated: null, source: syncrifyConfigured ? 'direct-pending' : 'none', error: _liveDriveData.error || undefined });
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

// Sales quotes (backed by the `contracts` table — see plan's "Contracts" nav rename)
app.get('/api/sales-quotes', (req, res) => {
  try { res.json(readContracts()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/sales-quotes', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid payload' });
    replaceContracts(req.body);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clients read/write
app.get('/api/clients', (req, res) => {
  try { res.json(readClients()); }
  catch(e) { res.status(500).json({ error: 'Failed to read client data' }); }
});

app.put('/api/clients', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid payload' });
    replaceClients(req.body);
    const sessionId = req.headers['x-session-id'] || req.headers['x-source-id'] || '';
    const techName  = req.headers['x-tech-name'] || '';
    pushEvent('clients-updated', { clients: req.body, sessionId, techName }, sessionId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Failed to write client data' }); }
});

// ── Purchase Requests (Quotes page) ────────────────────────────────────────────
// Full-object read/replace like clients/contracts, except approval_* columns
// are server-managed (set only by send-approval/poll-status below) so a normal
// frontend edit-and-save never clobbers in-flight approval state.
function readPurchaseRequests() {
  const prRows   = db.prepare('SELECT * FROM purchase_requests').all();
  const itemRows = db.prepare('SELECT * FROM purchase_request_items').all();
  const itemsByPr = {};
  for (const it of itemRows) {
    (itemsByPr[it.purchase_request_id] ||= []).push({
      id: it.id, description: it.description, qty: it.qty, estUnitCost: it.est_unit_cost, notes: it.notes,
      vendor: it.vendor, url: it.url, sku: it.sku, received: !!it.received,
    });
  }
  const out = {};
  for (const row of prRows) {
    out[row.id] = {
      id: row.id, clientId: row.client_id, clientName: row.client_name,
      requestedBy: row.requested_by, notes: row.notes,
      priority: !!row.priority, status: row.status, clientEmail: row.client_email,
      approvalStatus: row.approval_status, approvalId: row.approval_id,
      approvalSentAt: row.approval_sent_at, approvalResolvedAt: row.approval_resolved_at,
      invoiceId: row.invoice_id, number: row.number,
      createdAt: row.created_at, updatedAt: row.updated_at,
      items: itemsByPr[row.id] || [],
    };
  }
  return out;
}

function replacePurchaseRequests(obj) {
  const now = Date.now();
  db.transaction((data) => {
    const existing = {};
    for (const row of db.prepare('SELECT id, approval_status, approval_id, approval_token, approval_sent_at, approval_resolved_at, invoice_id, number, created_at FROM purchase_requests').all()) {
      existing[row.id] = row;
    }
    db.prepare('DELETE FROM purchase_request_items').run();
    db.prepare('DELETE FROM purchase_requests').run();
    const insertPr = db.prepare(`INSERT INTO purchase_requests
      (id, client_id, client_name, requested_by, notes, priority, status, client_email,
       approval_status, approval_id, approval_token, approval_sent_at, approval_resolved_at, invoice_id, number, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertItem = db.prepare('INSERT INTO purchase_request_items (purchase_request_id, description, qty, est_unit_cost, notes, vendor, url, sku, received) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const [id, pr] of Object.entries(data)) {
      const prev = existing[id];
      insertPr.run(
        id, pr.clientId||null, pr.clientName||null, pr.requestedBy||null, pr.notes||null,
        pr.priority?1:0, pr.status||'draft', pr.clientEmail||null,
        prev?.approval_status || 'not_sent', prev?.approval_id || null, prev?.approval_token || null,
        prev?.approval_sent_at || null, prev?.approval_resolved_at || null, prev?.invoice_id || null, prev?.number || null,
        prev?.created_at || now, now
      );
      for (const item of (pr.items||[])) {
        insertItem.run(id, item.description||'', item.qty||0, item.estUnitCost||0, item.notes||null,
          item.vendor||null, item.url||null, item.sku||null, item.received?1:0);
      }
    }
  })(obj);
}

app.get('/api/purchase-requests', (req, res) => {
  try { res.json(readPurchaseRequests()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/purchase-requests', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid payload' });
    replacePurchaseRequests(req.body);
    pushEvent('purchase-requests-updated', {}, req.headers['x-session-id']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// "Estimate #" — assigned the first time a PDF is generated for this request
// (preview or send-approval, whichever happens first), not at draft creation,
// so abandoned drafts never burn a number. Same race-free pattern as invoice numbering.
function getOrAssignEstimateNumber(id) {
  const row = db.prepare('SELECT number FROM purchase_requests WHERE id = ?').get(id);
  if (!row) throw new Error('Purchase request not found');
  if (row.number != null) return row.number;
  let number;
  db.transaction(() => {
    const maxRow = db.prepare('SELECT COALESCE(MAX(number), 1000) AS maxNumber FROM purchase_requests').get();
    number = maxRow.maxNumber + 1;
    db.prepare('UPDATE purchase_requests SET number = ?, updated_at = ? WHERE id = ?').run(number, Date.now(), id);
  })();
  return number;
}

// Returns { buffer, number } — the number is assigned (once, if not already)
// as a side effect, since generating the estimate PDF is what turns a draft
// into a numbered client-facing document.
async function buildEstimatePdf(id) {
  const row = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(id);
  if (!row) return null;
  const number = getOrAssignEstimateNumber(id);
  const items = db.prepare('SELECT description, qty, est_unit_cost FROM purchase_request_items WHERE purchase_request_id = ?').all(id)
    .map(it => ({ description: it.description, qty: it.qty, unitPrice: it.est_unit_cost }));
  const orgName = (readCfg().org_name) || 'System Alternatives';
  const doc = renderDocumentPdf({
    kind: 'Estimate', number, clientName: row.client_name, preparedBy: row.requested_by,
    items, notes: row.notes, orgName,
  });
  const buffer = await pdfBufferFromDoc(doc);
  return { buffer, number };
}

app.get('/api/purchase-requests/:id/pdf', async (req, res) => {
  try {
    const result = await buildEstimatePdf(req.params.id);
    if (!result) return res.status(404).json({ error: 'Purchase request not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Estimate-${result.number}.pdf"`);
    res.send(result.buffer);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sends a purchase request to SA-Website (systemalternatives.net) for client
// approval — an outbound-only call, since this app has no inbound public
// exposure. The result comes back later via the batched poll loop below, not
// an inbound webhook.
app.post('/api/purchase-requests/:id/send-approval', async (req, res) => {
  const { id } = req.params;
  try {
    const row = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Purchase request not found' });
    if (!row.client_email) return res.status(400).json({ error: 'Purchase request has no client email set' });

    const approvalSettings = readSettings();
    const apiBase = (approvalSettings.saWebsiteApiBase || '').replace(/\/+$/, '');
    const apiKey  = approvalSettings.saWebsiteApiKey || '';
    if (!apiBase || !apiKey) return res.status(500).json({ error: 'Client approval isn\'t set up yet — add the SA Website API Base URL and API Key in Settings.' });

    const items = db.prepare('SELECT description, qty, est_unit_cost AS estUnitCost, notes FROM purchase_request_items WHERE purchase_request_id = ?').all(id);
    const totalEstimate = items.reduce((sum, it) => sum + (it.qty||0) * (it.estUnitCost||0), 0);

    const { buffer: pdfBuffer, number: estimateNumber } = await buildEstimatePdf(id);

    const approvalId = 'apr-' + Date.now();
    const result = await jsonHttpRequest(`${apiBase}/approval_request.php`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: {
        mode: 'create',
        approval_id: approvalId,
        client_email: row.client_email,
        client_name: row.client_name,
        items,
        total_estimate: totalEstimate,
        notes: row.notes || '',
        pdf_base64: pdfBuffer.toString('base64'),
        pdf_filename: `Estimate-${estimateNumber}.pdf`,
      },
    });
    if (result.status !== 200 || !result.json?.ok) {
      return res.status(502).json({ error: result.json?.error || `SA-Website returned status ${result.status}` });
    }

    const now = Date.now();
    db.prepare(`UPDATE purchase_requests SET approval_status='pending', approval_id=?, approval_sent_at=?, updated_at=? WHERE id=?`)
      .run(approvalId, now, now, id);
    db.prepare('INSERT INTO logs (id, client_id, ts, data) VALUES (?, ?, ?, ?)')
      .run(`${now}-${Math.random().toString(36).slice(2,6)}`, row.client_id, now,
        JSON.stringify({ ts: new Date(now).toISOString(), tech: req.headers['x-tech-name']||'', action: 'purchase-request-sent-for-approval', clientId: row.client_id, clientName: row.client_name }));

    pushEvent('purchase-requests-updated', {}, req.headers['x-session-id']);
    res.json({ ok: true, approvalId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One outbound call per cycle, covering every outstanding approval — not one
// call per pending item — so polling cost stays flat regardless of how many
// purchase requests are awaiting a client decision.
async function pollApprovalStatusOnce() {
  try {
    const pending = db.prepare(`SELECT id, approval_id, client_id, client_name FROM purchase_requests WHERE approval_status = 'pending' AND approval_id IS NOT NULL`).all();
    const pollSettings = readSettings();
    const apiBase = (pollSettings.saWebsiteApiBase || '').replace(/\/+$/, '');
    const apiKey  = pollSettings.saWebsiteApiKey || '';
    if (pending.length > 0 && apiBase && apiKey) {
      const result = await jsonHttpRequest(`${apiBase}/approval_request.php`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: { mode: 'get_status', approval_ids: pending.map(p => p.approval_id) },
      });
      if (result.status === 200 && result.json?.ok) {
        const statuses = result.json.statuses || {};
        const now = Date.now();
        let anyResolved = false;
        for (const pr of pending) {
          const info = statuses[pr.approval_id];
          if (!info || info.status === 'pending') continue;
          anyResolved = true;
          db.prepare(`UPDATE purchase_requests SET approval_status=?, approval_resolved_at=?, updated_at=? WHERE id=?`)
            .run(info.status, info.resolved_at || now, now, pr.id);
          db.prepare('INSERT INTO logs (id, client_id, ts, data) VALUES (?, ?, ?, ?)')
            .run(`${now}-${Math.random().toString(36).slice(2,6)}`, pr.client_id, now,
              JSON.stringify({ ts: new Date(now).toISOString(), tech: '', action: `purchase-request-${info.status}`, clientId: pr.client_id, clientName: pr.client_name }));
        }
        if (anyResolved) pushEvent('purchase-requests-updated', {}, 'server');
      } else {
        console.log(`[approval-poll] SA-Website returned status ${result.status}`);
      }
    }
  } catch (e) {
    console.log(`[approval-poll] Poll failed: ${e.message}`);
  }
}

function pollApprovalStatusLoop() {
  pollApprovalStatusOnce().finally(() => {
    const settings    = readSettings();
    const intervalSec = Math.max(60, parseInt(settings.approvalPollSec) || 600);
    setTimeout(pollApprovalStatusLoop, intervalSec * 1000);
  });
}

// ── Invoices (Quotes page, tracking-only) ──────────────────────────────────────
// GET/PUT edit existing invoices (status, line items) like the other full-object
// endpoints; POST is the only path that assigns a new sequential invoice number,
// done inside a transaction so concurrent creates can never collide.
function readInvoices() {
  const invRows  = db.prepare('SELECT * FROM invoices').all();
  const itemRows = db.prepare('SELECT * FROM invoice_line_items').all();
  const itemsByInv = {};
  for (const it of itemRows) {
    (itemsByInv[it.invoice_id] ||= []).push({ id: it.id, description: it.description, qty: it.qty, unitPrice: it.unit_price });
  }
  const out = {};
  for (const row of invRows) {
    out[row.id] = {
      id: row.id, number: row.number, clientId: row.client_id, clientName: row.client_name,
      status: row.status, taxRate: row.tax_rate, notes: row.notes,
      sourcePurchaseRequestId: row.source_purchase_request_id,
      issueDate: row.issue_date, dueDate: row.due_date, paidAt: row.paid_at,
      createdAt: row.created_at, updatedAt: row.updated_at,
      lineItems: itemsByInv[row.id] || [],
    };
  }
  return out;
}

function replaceInvoiceEdits(obj) {
  const now = Date.now();
  db.transaction((data) => {
    const existing = {};
    for (const row of db.prepare('SELECT id, number, created_at FROM invoices').all()) existing[row.id] = row;
    db.prepare('DELETE FROM invoice_line_items').run();
    db.prepare('DELETE FROM invoices').run();
    const insertInv = db.prepare(`INSERT INTO invoices
      (id, number, client_id, client_name, status, tax_rate, notes, source_purchase_request_id, issue_date, due_date, paid_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertItem = db.prepare('INSERT INTO invoice_line_items (invoice_id, description, qty, unit_price) VALUES (?,?,?,?)');
    for (const [id, inv] of Object.entries(data)) {
      const prev = existing[id];
      const number = inv.number ?? prev?.number;
      if (number == null) throw new Error(`Invoice ${id} is missing its sequential number`);
      insertInv.run(
        id, number, inv.clientId||null, inv.clientName||null, inv.status||'draft', inv.taxRate||0, inv.notes||null,
        inv.sourcePurchaseRequestId||null, inv.issueDate||null, inv.dueDate||null, inv.paidAt||null,
        prev?.created_at || inv.createdAt || now, now
      );
      for (const item of (inv.lineItems||[])) {
        insertItem.run(id, item.description||'', item.qty||0, item.unitPrice||0);
      }
    }
  })(obj);
}

function createInvoice(payload) {
  const now = Date.now();
  const id  = 'inv-' + now + '-' + Math.random().toString(36).slice(2, 6);
  let number;
  db.transaction(() => {
    const row = db.prepare('SELECT COALESCE(MAX(number), 1000) AS maxNumber FROM invoices').get();
    number = row.maxNumber + 1;
    db.prepare(`INSERT INTO invoices
      (id, number, client_id, client_name, status, tax_rate, notes, source_purchase_request_id, issue_date, due_date, paid_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, number, payload.clientId||null, payload.clientName||null, payload.status||'draft', payload.taxRate||0,
           payload.notes||null, payload.sourcePurchaseRequestId||null, payload.issueDate||now, payload.dueDate||null, null, now, now);
    const insertItem = db.prepare('INSERT INTO invoice_line_items (invoice_id, description, qty, unit_price) VALUES (?,?,?,?)');
    for (const item of (payload.lineItems||[])) {
      insertItem.run(id, item.description||'', item.qty||0, item.unitPrice||0);
    }
  })();
  return { id, number };
}

app.get('/api/invoices', (req, res) => {
  try { res.json(readInvoices()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/invoices', (req, res) => {
  try {
    const { id, number } = createInvoice(req.body || {});
    pushEvent('invoices-updated', {}, req.headers['x-session-id']);
    res.json({ ok: true, id, number });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/invoices', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid payload' });
    replaceInvoiceEdits(req.body);
    pushEvent('invoices-updated', {}, req.headers['x-session-id']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/invoices/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id); // cascades to invoice_line_items
    pushEvent('invoices-updated', {}, req.headers['x-session-id']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/:id/pdf', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Invoice not found' });
    const items = db.prepare('SELECT description, qty, unit_price AS unitPrice FROM invoice_line_items WHERE invoice_id = ?').all(row.id);
    const orgName = (readCfg().org_name) || 'System Alternatives';
    const doc = renderDocumentPdf({
      kind: 'Invoice', number: row.number, clientName: row.client_name, preparedBy: null,
      items, notes: row.notes, taxRate: row.tax_rate, dueDate: row.due_date, orgName,
    });
    pdfBufferFromDoc(doc).then(buf => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Invoice-${row.number}.pdf"`);
      res.send(buf);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/purchase-requests/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM purchase_requests WHERE id = ?').run(req.params.id); // cascades to purchase_request_items
    pushEvent('purchase-requests-updated', {}, req.headers['x-session-id']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Turns a received Purchase Request into a real Invoice — same client + line
// items (vendor/url/sku are internal-purchasing-only fields and are dropped,
// matching the "no internal detail on client-facing documents" rule), linked
// back via source_purchase_request_id/invoice_id so each keeps a pointer to
// the other. The two stay separate records (not merged) so a request can
// still be split across multiple invoices later if needed.
app.post('/api/purchase-requests/:id/generate-invoice', (req, res) => {
  try {
    const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
    if (!pr) return res.status(404).json({ error: 'Purchase request not found' });
    if (pr.invoice_id) return res.status(400).json({ error: 'An invoice has already been generated for this request' });

    const items = db.prepare('SELECT description, qty, est_unit_cost FROM purchase_request_items WHERE purchase_request_id = ?').all(pr.id);
    const { id: invoiceId, number } = createInvoice({
      clientId: pr.client_id,
      clientName: pr.client_name,
      notes: pr.notes,
      sourcePurchaseRequestId: pr.id,
      lineItems: items.map(it => ({ description: it.description, qty: it.qty, unitPrice: it.est_unit_cost })),
    });

    const now = Date.now();
    db.prepare(`UPDATE purchase_requests SET status='invoiced', invoice_id=?, updated_at=? WHERE id=?`).run(invoiceId, now, pr.id);

    pushEvent('purchase-requests-updated', {}, req.headers['x-session-id']);
    pushEvent('invoices-updated', {}, req.headers['x-session-id']);
    res.json({ ok: true, invoiceId, number });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
const SECRET_MASK    = '********';
app.get('/api/settings', (req, res) => {
  try {
    const settings = kvGet(db, 'settings', null);
    if (!settings) return res.json({ staleDays: 30, dueDays: 3 });
    const out = { ...settings };
    if (out.syncrifyPass) out.syncrifyPass = SECRET_MASK;
    if (out.saWebsiteApiKey) out.saWebsiteApiKey = SECRET_MASK;
    res.json(out);
  } catch(e) { res.json({ staleDays: 30, dueDays: 3 }); }
});
app.put('/api/settings', (req, res) => {
  try {
    const incoming = req.body;
    const existing = readSettings();
    if (incoming.syncrifyPass === SECRET_MASK) incoming.syncrifyPass = existing.syncrifyPass || '';
    if (incoming.saWebsiteApiKey === SECRET_MASK) incoming.saWebsiteApiKey = existing.saWebsiteApiKey || '';
    kvSet(db, 'settings', incoming);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Backups
app.get('/api/backups', (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('app-') && f.endsWith('.db'))
      .sort().reverse()
      .map(f => ({
        name: f,
        size: fs.statSync(path.join(BACKUP_DIR,f)).size,
        mtime: fs.statSync(path.join(BACKUP_DIR,f)).mtime,
      }));
    res.json(files);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backups', async (req, res) => {
  const name = await doBackup();
  if (name) res.json({ ok: true, name });
  else res.status(500).json({ error: 'Backup failed' });
});

app.get('/api/backups/download', (req, res) => {
  // Download latest or specific file
  try {
    const file = req.query.file || fs.readdirSync(BACKUP_DIR)
      .filter(f=>f.startsWith('app-')&&f.endsWith('.db')).sort().reverse()[0];
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
function readLogs(clientId, limit){
  const rows = clientId
    ? db.prepare('SELECT data FROM logs WHERE client_id = ? ORDER BY ts DESC LIMIT ?').all(clientId, limit)
    : db.prepare('SELECT data FROM logs ORDER BY ts DESC LIMIT ?').all(limit);
  return rows.map(r => JSON.parse(r.data));
}
app.get('/api/logs',(req,res)=>{
  try{
    const {clientId,limit=500}=req.query;
    res.json(readLogs(clientId || null, parseInt(limit) || 500));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/logs',(req,res)=>{
  try{
    const id=Date.now()+'-'+Math.random().toString(36).slice(2,6);
    const entry={...req.body,id};
    const tsMs = entry.ts ? (Date.parse(entry.ts) || Date.now()) : Date.now();
    db.prepare('INSERT INTO logs (id, client_id, ts, data) VALUES (?, ?, ?, ?)').run(id, entry.clientId || null, tsMs, JSON.stringify(entry));
    db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY ts DESC LIMIT ?)').run(MAX_LOGS);
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
  try { fileSize=fs.statSync(DB_FILE).size; } catch(_){}
  res.json({
    status:'ok', uptime:Math.round(process.uptime()),
    dataFileSizeKB:Math.round(fileSize/1024),
    sseClients:sseClients.size,
    nodeVersion:process.version, platform:os.platform(),
  });
});

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => console.log(`Checklist API on 127.0.0.1:${PORT}`));
  pollSyncrifyActivityLoop();
  pollSyncrifyDataLoop();
  pollApprovalStatusLoop();
  pollSyncroCustomersLoop();
}

loadLiveCache();

app.locals.db = db;
app.locals.pollApprovalStatusLoopOnce = pollApprovalStatusOnce;
module.exports = app;
