// One-time migration: reads the existing flat JSON data files and loads them
// into data/app.db. Idempotent (checks a completion marker in kv_store) so it
// can be safely re-run. Existing JSON files are left in place as a fallback.
const fs = require('fs');
const path = require('path');
const { createDb, kvGet, kvSet } = require('../db');

function readJsonSafe(dataDir, file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')); }
  catch (_) { return fallback; }
}

function migrate(dataDir) {
  const db = createDb(dataDir);

  if (kvGet(db, 'migration_completed_at', null)) {
    db.close();
    return { skipped: true };
  }

  const now = Date.now();

  const clients = readJsonSafe(dataDir, 'clients.json', {});
  const insertClient = db.prepare('INSERT OR REPLACE INTO clients (id, data, updated_at) VALUES (?, ?, ?)');
  db.transaction((obj) => {
    for (const [id, value] of Object.entries(obj)) insertClient.run(id, JSON.stringify(value), now);
  })(clients);

  const contracts = readJsonSafe(dataDir, 'sales-quotes.json', {});
  const insertContract = db.prepare('INSERT OR REPLACE INTO contracts (id, data, updated_at) VALUES (?, ?, ?)');
  db.transaction((obj) => {
    for (const [id, value] of Object.entries(obj)) insertContract.run(id, JSON.stringify(value), now);
  })(contracts);

  const config = readJsonSafe(dataDir, 'config.json', null);
  if (config) kvSet(db, 'config', config);

  const settings = readJsonSafe(dataDir, 'settings.json', null);
  if (settings) kvSet(db, 'settings', settings);

  const liveCache = readJsonSafe(dataDir, 'live-backup-cache.json', null);
  if (liveCache) kvSet(db, 'live_backup_cache', liveCache);

  const logs = readJsonSafe(dataDir, 'logs.json', []);
  const logsArr = Array.isArray(logs) ? logs : [];
  const insertLog = db.prepare('INSERT OR IGNORE INTO logs (id, client_id, ts, data) VALUES (?, ?, ?, ?)');
  db.transaction((arr) => {
    for (const entry of arr) {
      const id = entry.id != null ? String(entry.id) : `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const tsMs = entry.ts ? (Date.parse(entry.ts) || 0) : 0;
      insertLog.run(id, entry.clientId || null, tsMs, JSON.stringify(entry));
    }
  })(logsArr);

  kvSet(db, 'migration_completed_at', now);
  db.close();

  return {
    skipped: false,
    clients: Object.keys(clients).length,
    contracts: Object.keys(contracts).length,
    logs: logsArr.length,
    hasConfig: !!config,
    hasSettings: !!settings,
  };
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const result = migrate(dataDir);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { migrate };
