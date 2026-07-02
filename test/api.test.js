const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { createDb, kvGet, kvSet } = require('../db');

let server, baseUrl, dataDir, app;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-test-'));
  process.env.DATA_DIR = dataDir;
  app = require('../server.js');
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  app.locals.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/health returns ok status', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('GET /api/clients returns an empty object initially', async () => {
  const res = await fetch(`${baseUrl}/api/clients`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
});

test('PUT /api/clients persists data for a subsequent GET', async () => {
  const clients = { abc123: { id: 'abc123', name: 'Test Client' } };
  const putRes = await fetch(`${baseUrl}/api/clients`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(clients),
  });
  assert.equal(putRes.status, 200);
  const getRes = await fetch(`${baseUrl}/api/clients`);
  assert.deepEqual(await getRes.json(), clients);
});

test('GET /api/config returns 404 before any config exists', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.equal(res.status, 404);
});

test('PUT /api/config creates config and is reflected in GET', async () => {
  const putRes = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgName: 'Acme Co', syncroSubdomain: 'acme', syncroToken: 'tok12345' }),
  });
  assert.equal(putRes.status, 200);
  const getRes = await fetch(`${baseUrl}/api/config`);
  const body = await getRes.json();
  assert.equal(body.orgName, 'Acme Co');
  assert.equal(body.syncroSubdomain, 'acme');
  assert.equal(body.syncroTokenSet, true);
  assert.equal(body.syncroTokenHint, 'tok12•••••••••••');
});

test('PUT /api/config without a token preserves the existing token', async () => {
  const putRes = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgName: 'Acme Co Updated' }),
  });
  assert.equal(putRes.status, 200);
  const getRes = await fetch(`${baseUrl}/api/config`);
  const body = await getRes.json();
  assert.equal(body.orgName, 'Acme Co Updated');
  assert.equal(body.syncroTokenSet, true);
});

test('PUT /api/settings overwrites and GET returns it back, masking syncrifyPass', async () => {
  const settings = { staleDays: 45, dueDays: 5, syncrifyPass: 'sup3rsecret' };
  const putRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  assert.equal(putRes.status, 200);
  const getRes = await fetch(`${baseUrl}/api/settings`);
  const body = await getRes.json();
  assert.equal(body.staleDays, 45);
  assert.equal(body.dueDays, 5);
  assert.equal(body.syncrifyPass, '********');
});

test('PUT /api/settings with the masked password preserves the real one', async () => {
  // Simulate the client round-trip: re-save settings as returned by GET (masked password included).
  const getRes = await fetch(`${baseUrl}/api/settings`);
  const settings = await getRes.json();
  assert.equal(settings.syncrifyPass, '********');
  settings.staleDays = 60;
  const putRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  assert.equal(putRes.status, 200);
  const checkDb = createDb(dataDir);
  const raw = kvGet(checkDb, 'settings', {});
  checkDb.close();
  assert.equal(raw.syncrifyPass, 'sup3rsecret');
  assert.equal(raw.staleDays, 60);
});

test('static assets are served with no-store caching', async () => {
  for (const file of ['/', '/app.js', '/styles.css']) {
    const res = await fetch(`${baseUrl}${file}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('PUT /api/purchase-requests persists items for a subsequent GET', async () => {
  const prs = {
    'pr-1': {
      clientId: 'abc123', clientName: 'Test Client', requestedBy: 'Alice',
      vendor: 'Acme Supplies', notes: 'Urgent', priority: true, status: 'draft',
      clientEmail: 'client@example.com',
      items: [{ description: 'Widget', qty: 3, estUnitCost: 12.5, notes: '' }],
    },
  };
  const putRes = await fetch(`${baseUrl}/api/purchase-requests`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prs),
  });
  assert.equal(putRes.status, 200);
  const getRes = await fetch(`${baseUrl}/api/purchase-requests`);
  const body = await getRes.json();
  assert.equal(body['pr-1'].clientName, 'Test Client');
  assert.equal(body['pr-1'].approvalStatus, 'not_sent');
  assert.equal(body['pr-1'].items.length, 1);
  assert.equal(body['pr-1'].items[0].description, 'Widget');
});

test('PUT /api/purchase-requests does not clobber approval state set by send-approval', async () => {
  // Simulate an in-flight approval by writing directly to the db, then save an
  // unrelated edit via the normal full-object PUT and confirm approval fields survive.
  const db = app.locals.db;
  db.prepare(`UPDATE purchase_requests SET approval_status='pending', approval_id='apr-test', approval_sent_at=123 WHERE id='pr-1'`).run();

  const getRes = await fetch(`${baseUrl}/api/purchase-requests`);
  const prs = await getRes.json();
  prs['pr-1'].notes = 'Updated notes';
  await fetch(`${baseUrl}/api/purchase-requests`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prs),
  });

  const after = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
  assert.equal(after['pr-1'].notes, 'Updated notes');
  assert.equal(after['pr-1'].approvalStatus, 'pending');
  assert.equal(after['pr-1'].approvalId, 'apr-test');
});

test('POST /api/invoices assigns sequential numbers with no collisions under concurrent creates', async () => {
  const makeInvoice = () => fetch(`${baseUrl}/api/invoices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'abc123', clientName: 'Test Client', lineItems: [{ description: 'Service', qty: 1, unitPrice: 100 }] }),
  }).then(r => r.json());

  const results = await Promise.all([makeInvoice(), makeInvoice(), makeInvoice()]);
  const numbers = results.map(r => r.number);
  assert.equal(new Set(numbers).size, numbers.length, 'invoice numbers must be unique');
  assert.ok(numbers.every(n => n >= 1001));
});

test('PUT /api/invoices edits status without touching the assigned number', async () => {
  const created = await (await fetch(`${baseUrl}/api/invoices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'abc123', clientName: 'Test Client', lineItems: [{ description: 'Service', qty: 2, unitPrice: 50 }] }),
  })).json();

  const invoices = await (await fetch(`${baseUrl}/api/invoices`)).json();
  invoices[created.id].status = 'sent';
  const putRes = await fetch(`${baseUrl}/api/invoices`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(invoices),
  });
  assert.equal(putRes.status, 200);

  const after = await (await fetch(`${baseUrl}/api/invoices`)).json();
  assert.equal(after[created.id].status, 'sent');
  assert.equal(after[created.id].number, created.number);
  assert.equal(after[created.id].lineItems[0].description, 'Service');
});

test('send-approval flow: create + batched poll flips approval status via a mock SA-Website', async () => {
  // Stand in for systemalternatives.net's approval_request.php: acknowledges
  // "create" and reports every pending id as "approved" on "get_status".
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      res.setHeader('Content-Type', 'application/json');
      if (data.mode === 'create') {
        res.end(JSON.stringify({ ok: true }));
      } else if (data.mode === 'get_status') {
        const statuses = {};
        for (const id of data.approval_ids) statuses[id] = { status: 'approved', resolved_at: Date.now() };
        res.end(JSON.stringify({ ok: true, statuses }));
      } else {
        res.end(JSON.stringify({ ok: false, error: 'unknown mode' }));
      }
    });
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  // SA Website API base/key live in Settings (like Syncro/Syncrify creds), not env vars.
  const priorSettings = await (await fetch(`${baseUrl}/api/settings`)).json();
  await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...priorSettings, saWebsiteApiBase: mockBase, saWebsiteApiKey: 'test-key' }),
  });

  try {
    const sendRes = await fetch(`${baseUrl}/api/purchase-requests/pr-1/send-approval`, { method: 'POST' });
    assert.equal(sendRes.status, 200);
    const sendBody = await sendRes.json();
    assert.ok(sendBody.approvalId);

    let after = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
    assert.equal(after['pr-1'].approvalStatus, 'pending');

    // Poll runs on its own timer in the live server; call the internal function directly here
    // to verify the batched get_status/update logic without waiting on a real interval.
    await app.locals.pollApprovalStatusLoopOnce();

    after = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
    assert.equal(after['pr-1'].approvalStatus, 'approved');
    assert.ok(after['pr-1'].approvalResolvedAt);
  } finally {
    await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...priorSettings, saWebsiteApiBase: '', saWebsiteApiKey: '' }),
    });
    await new Promise(resolve => mock.close(resolve));
  }
});

test('send-approval returns 400 when the purchase request has no client email', async () => {
  await fetch(`${baseUrl}/api/purchase-requests`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'pr-no-email': { clientId: 'abc123', clientName: 'Test Client', items: [] } }),
  });
  const res = await fetch(`${baseUrl}/api/purchase-requests/pr-no-email/send-approval`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('migrate-json-to-sqlite reads legacy JSON files into app.db and is idempotent', async () => {
  const { migrate } = require('../scripts/migrate-json-to-sqlite');
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-legacy-'));
  fs.writeFileSync(path.join(legacyDir, 'clients.json'), JSON.stringify({ c1: { id: 'c1', name: 'Legacy Client' } }));
  fs.writeFileSync(path.join(legacyDir, 'sales-quotes.json'), JSON.stringify({ q1: { id: 'q1', name: 'Legacy Quote' } }));
  fs.writeFileSync(path.join(legacyDir, 'config.json'), JSON.stringify({ org_name: 'Legacy Org' }));
  fs.writeFileSync(path.join(legacyDir, 'logs.json'), JSON.stringify([{ id: '1', ts: new Date().toISOString(), clientId: 'c1', action: 'test' }]));

  try {
    const result = migrate(legacyDir);
    assert.equal(result.skipped, false);
    assert.equal(result.clients, 1);
    assert.equal(result.contracts, 1);
    assert.equal(result.logs, 1);
    assert.equal(result.hasConfig, true);

    const checkDb = createDb(legacyDir);
    const client = checkDb.prepare('SELECT data FROM clients WHERE id = ?').get('c1');
    assert.equal(JSON.parse(client.data).name, 'Legacy Client');
    checkDb.close();

    const second = migrate(legacyDir);
    assert.equal(second.skipped, true);
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

test('purchase request line items round-trip vendor/url/sku/received', async () => {
  const prs = {
    'pr-robust': {
      clientId: 'abc123', clientName: 'Test Client', status: 'draft',
      items: [{ description: 'Switch', qty: 2, estUnitCost: 300, vendor: 'CDW', url: 'https://cdw.com/product/123', sku: 'SW-123', received: true }],
    },
  };
  await fetch(`${baseUrl}/api/purchase-requests`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prs),
  });
  const body = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
  const item = body['pr-robust'].items[0];
  assert.equal(item.vendor, 'CDW');
  assert.equal(item.url, 'https://cdw.com/product/123');
  assert.equal(item.sku, 'SW-123');
  assert.equal(item.received, true);
});

test('generate-invoice creates a linked invoice and blocks a second conversion', async () => {
  await fetch(`${baseUrl}/api/purchase-requests`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'pr-convert': {
      clientId: 'abc123', clientName: 'Test Client', status: 'received',
      items: [{ description: 'Server', qty: 1, estUnitCost: 2000, vendor: 'Ingram' }],
    }}),
  });

  const res = await fetch(`${baseUrl}/api/purchase-requests/pr-convert/generate-invoice`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.invoiceId);
  assert.ok(body.number >= 1001);

  const invoices = await (await fetch(`${baseUrl}/api/invoices`)).json();
  const inv = invoices[body.invoiceId];
  assert.equal(inv.clientName, 'Test Client');
  assert.equal(inv.sourcePurchaseRequestId, 'pr-convert');
  assert.equal(inv.lineItems[0].description, 'Server');
  assert.equal(inv.lineItems[0].unitPrice, 2000);
  // vendor is an internal-purchasing-only field and must not leak onto the invoice
  assert.equal(inv.lineItems[0].vendor, undefined);

  const prs = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
  assert.equal(prs['pr-convert'].status, 'invoiced');
  assert.equal(prs['pr-convert'].invoiceId, body.invoiceId);

  const second = await fetch(`${baseUrl}/api/purchase-requests/pr-convert/generate-invoice`, { method: 'POST' });
  assert.equal(second.status, 400);
});

test('DELETE /api/purchase-requests/:id and /api/invoices/:id remove the record', async () => {
  await fetch(`${baseUrl}/api/purchase-requests`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'pr-delete-me': { clientId: 'abc123', clientName: 'Test Client', items: [] } }),
  });
  const delPrRes = await fetch(`${baseUrl}/api/purchase-requests/pr-delete-me`, { method: 'DELETE' });
  assert.equal(delPrRes.status, 200);
  const prsAfter = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
  assert.equal(prsAfter['pr-delete-me'], undefined);

  const created = await (await fetch(`${baseUrl}/api/invoices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'abc123', clientName: 'Test Client', lineItems: [] }),
  })).json();
  const delInvRes = await fetch(`${baseUrl}/api/invoices/${created.id}`, { method: 'DELETE' });
  assert.equal(delInvRes.status, 200);
  const invoicesAfter = await (await fetch(`${baseUrl}/api/invoices`)).json();
  assert.equal(invoicesAfter[created.id], undefined);
});

test('GET /api/syncro-customers searches the local cache table', async () => {
  const db = app.locals.db;
  const now = Date.now();
  db.prepare('INSERT INTO syncro_customers (id, business_name, email, phone, data, updated_at) VALUES (?,?,?,?,?,?)')
    .run('syn-1', 'Acme Corp', 'billing@acme.com', '555-1000', '{}', now);
  db.prepare('INSERT INTO syncro_customers (id, business_name, email, phone, data, updated_at) VALUES (?,?,?,?,?,?)')
    .run('syn-2', 'Widget Co', 'ap@widget.co', '555-2000', '{}', now);

  const all = await (await fetch(`${baseUrl}/api/syncro-customers`)).json();
  assert.ok(all.length >= 2);

  const filtered = await (await fetch(`${baseUrl}/api/syncro-customers?q=Acme`)).json();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].businessName, 'Acme Corp');
  assert.equal(filtered[0].email, 'billing@acme.com');
});

test('POST /api/syncro-customers/refresh fails cleanly when Syncro is not configured', async () => {
  // An earlier test in this suite configures syncro_subdomain/syncro_api_token;
  // clear them here so this hits the "not configured" guard rather than
  // attempting a real network call to a fake subdomain.
  kvSet(app.locals.db, 'config', {});
  const res = await fetch(`${baseUrl}/api/syncro-customers/refresh`, { method: 'POST' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Syncro not configured');
});
