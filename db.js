const path = require('path');
const Database = require('better-sqlite3');

// Hybrid schema: clients/contracts keep their existing nested JSON shape as a
// blob column (frontend contract unchanged); purchase requests, invoices, and
// logs get real relational tables since they benefit from indexed queries and
// transactions (invoice numbering, "all pending approvals", filtered log reads).
function createDb(dataDir) {
  const dbPath = path.join(dataDir, 'app.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_client_ts ON logs(client_id, ts);
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);

    CREATE TABLE IF NOT EXISTS purchase_requests (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      client_name TEXT,
      requested_by TEXT,
      vendor TEXT,
      notes TEXT,
      priority INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft',
      client_email TEXT,
      approval_status TEXT DEFAULT 'not_sent',
      approval_id TEXT,
      approval_token TEXT,
      approval_sent_at INTEGER,
      approval_resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pr_approval_status ON purchase_requests(approval_status);
    CREATE INDEX IF NOT EXISTS idx_pr_client ON purchase_requests(client_id);

    CREATE TABLE IF NOT EXISTS purchase_request_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_request_id TEXT NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
      description TEXT,
      qty REAL,
      est_unit_cost REAL,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pri_pr ON purchase_request_items(purchase_request_id);

    -- "Items for Purchase" — an internal fulfillment tracker, independent from
    -- purchase_request_items (the client-facing Quote). These don't need to
    -- correspond 1:1: one bundled Quote line can be fulfilled by several real
    -- purchase lines (e.g. one $608 "NAS" quote line = an enclosure + two
    -- drives + shipping here). Must never be selected into the client PDF, the
    -- SA-Website approval payload, or a generated invoice — see the comments
    -- at buildEstimatePdf/send-approval/generate-invoice in server.js.
    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_request_id TEXT NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
      item TEXT,
      description TEXT,
      qty REAL,
      cost REAL,
      markup_pct REAL DEFAULT 0,
      vendor TEXT,
      url TEXT,
      purchasing_notes TEXT,
      received INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pi_pr ON purchase_items(purchase_request_id);

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      number INTEGER UNIQUE,
      client_id TEXT,
      client_name TEXT,
      status TEXT DEFAULT 'draft',
      tax_rate REAL DEFAULT 0,
      notes TEXT,
      source_purchase_request_id TEXT,
      issue_date INTEGER,
      due_date INTEGER,
      paid_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);

    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      description TEXT,
      qty REAL,
      unit_price REAL
    );
    CREATE INDEX IF NOT EXISTS idx_ili_invoice ON invoice_line_items(invoice_id);

    -- Shop stock/inventory (spare parts, loaner hardware, etc. kept on hand) —
    -- a flat single-entity list, same full-object read/replace convention as
    -- clients/contracts (no child items table needed).
    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      name TEXT,
      sku TEXT,
      category TEXT,
      qty_on_hand REAL DEFAULT 0,
      reorder_threshold REAL,
      cost REAL,
      location TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_name ON inventory_items(name);

    CREATE TABLE IF NOT EXISTS syncro_customers (
      id TEXT PRIMARY KEY,
      business_name TEXT,
      email TEXT,
      phone TEXT,
      data TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_syncro_customers_name ON syncro_customers(business_name);
  `);

  // Additive migrations for columns introduced after the tables above first
  // shipped — CREATE TABLE IF NOT EXISTS alone won't add columns to a
  // database that already exists on a deployed server.
  ensureColumns(db, 'purchase_requests', [
    ['invoice_id', 'TEXT'],
    ['number', 'INTEGER'], // "Estimate #", assigned at send-for-approval time — SQLite allows multiple NULLs in a UNIQUE index, so drafts stay numberless without conflict
    ['approval_ip', 'TEXT'],           // e-signature stamp fields, filled in once the poll loop learns the request was resolved
    ['approval_verification_id', 'TEXT'],
    ['approval_pdf_signed', 'INTEGER DEFAULT 0'], // whether the stamped PDF has already been rendered + pushed back to SA-Website
    ['internal_notes', 'TEXT'],  // tech-only — never sent to SA-Website, the PDF, or any client-facing surface
    ['signer_name', 'TEXT'],     // typed name the client entered to Approve/Deny
    ['deny_reason', 'TEXT'],     // required when the client denies
    ['approval_link', 'TEXT'],   // client-facing approve.html?token=... URL (full/raw), for reference
    ['approval_short_link', 'TEXT'], // self-hosted short link (SA-Website /l/<code>) — what "Copy Approval Link" actually copies
  ]);
  ensureColumns(db, 'purchase_request_items', [
    ['vendor', 'TEXT'],
    ['url', 'TEXT'],
    ['sku', 'TEXT'],
    ['received', 'INTEGER DEFAULT 0'],
  ]);
  ensureColumns(db, 'inventory_items', [
    ['purchase_link', 'TEXT'], // quick-reorder URL for this item
  ]);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_number ON purchase_requests(number);`);

  backfillPurchaseItems(db);

  return db;
}

// One-time backfill for the purchase_items split introduced after
// vendor/url/notes/received had already been living directly on
// purchase_request_items (the client-facing Quote table) — copies any
// already-entered purchasing progress into the new internal-only table so it
// isn't silently lost when the Quote editor stops exposing those fields.
// Guarded by a kv_store marker rather than just "is purchase_items empty?",
// since a tech could legitimately delete every purchase_items row later and
// an empty-table check alone would silently re-run and duplicate rows.
function backfillPurchaseItems(db) {
  if (kvGet(db, 'purchase_items_backfilled_at', null)) return;
  const legacyRows = db.prepare(`
    SELECT purchase_request_id, description, qty, est_unit_cost, sku, vendor, url, notes, received
    FROM purchase_request_items
    WHERE (vendor IS NOT NULL AND vendor <> '')
       OR (url IS NOT NULL AND url <> '')
       OR (notes IS NOT NULL AND notes <> '')
       OR received = 1
  `).all();
  if (legacyRows.length) {
    const insertBackfill = db.prepare(`INSERT INTO purchase_items
      (purchase_request_id, item, description, qty, cost, markup_pct, vendor, url, purchasing_notes, received)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      for (const r of legacyRows) {
        // markup_pct=0 so the computed price (cost*(1+markup/100)) exactly
        // matches the historical est_unit_cost until a tech adjusts it.
        insertBackfill.run(r.purchase_request_id, r.sku || null, r.description, r.qty,
          r.est_unit_cost || 0, 0, r.vendor, r.url, r.notes || null, r.received);
      }
    })();
  }
  kvSet(db, 'purchase_items_backfilled_at', Date.now());
}

function ensureColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (_) { return fallback; }
}

function kvSet(db, key, value) {
  db.prepare(`
    INSERT INTO kv_store (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}

module.exports = { createDb, kvGet, kvSet };
