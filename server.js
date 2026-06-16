const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const https    = require('https');
const http     = require('http');
const { exec } = require('child_process');

const app        = express();
const PORT       = process.env.PORT || 3001;
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE  = path.join(DATA_DIR, 'clients.json');
const CFG_FILE   = path.join(DATA_DIR, 'config.json');
const LOG_FILE   = path.join(DATA_DIR, 'logs.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LIVE_CACHE_FILE = path.join(DATA_DIR, 'live-backup-cache.json');
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

let _liveBackupData = { data: [], lastUpdated: null, error: null };
let _liveDriveData  = { data: null, lastUpdated: null, error: null };

// Persists _liveBackupData/_liveDriveData to disk so they survive a server
// restart instead of sitting empty until the next poll completes.
function loadLiveCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(LIVE_CACHE_FILE, 'utf8'));
    if (cached.backupData?.lastUpdated) _liveBackupData = { data: cached.backupData.data || [], lastUpdated: cached.backupData.lastUpdated, error: null };
    if (cached.driveData?.lastUpdated)  _liveDriveData  = { data: cached.driveData.data || null, lastUpdated: cached.driveData.lastUpdated, error: null };
  } catch (_) {}
}

function saveLiveCache() {
  try {
    atomicWrite(LIVE_CACHE_FILE, JSON.stringify({
      backupData: { data: _liveBackupData.data, lastUpdated: _liveBackupData.lastUpdated },
      driveData:  { data: _liveDriveData.data, lastUpdated: _liveDriveData.lastUpdated },
    }, null, 2));
  } catch (_) {}
}

async function pollSyncrifyDataLoop() {
  const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
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
    const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
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
    const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
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
    const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
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
    const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
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
    const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
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

// Sales quotes
const SALES_QUOTES_FILE = path.join(DATA_DIR, 'sales-quotes.json');
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
const SETTINGS_FILE  = path.join(DATA_DIR, 'settings.json');
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

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => console.log(`Checklist API on 127.0.0.1:${PORT}`));
  pollSyncrifyActivityLoop();
  pollSyncrifyDataLoop();
}

loadLiveCache();

module.exports = app;
