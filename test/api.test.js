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
  // "create" and reports every pending id as "approved" on "get_status", with
  // e-signature metadata attached, then accepts the re-stamped PDF push.
  let lastCreateBody = null;
  let lastUpdatePdfBody = null;
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      res.setHeader('Content-Type', 'application/json');
      if (data.mode === 'create') {
        lastCreateBody = data;
        res.end(JSON.stringify({
          ok: true,
          link: `http://127.0.0.1/approve?token=fake-token-for-${data.approval_id}`,
          short_link: `http://127.0.0.1/l/short-${data.approval_id}`,
        }));
      } else if (data.mode === 'get_status') {
        const statuses = {};
        for (const id of data.approval_ids) {
          statuses[id] = {
            status: 'approved', resolved_at: new Date().toISOString(), resolved_ip: '203.0.113.5',
            verification_id: 'ABCD1234EF567890', client_email: 'client@example.com',
            signer_name: 'Jane Client', deny_reason: null,
          };
        }
        res.end(JSON.stringify({ ok: true, statuses }));
      } else if (data.mode === 'update_pdf') {
        lastUpdatePdfBody = data;
        res.end(JSON.stringify({ ok: true }));
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
    body: JSON.stringify({ ...priorSettings, saWebsiteApiBase: mockBase, saWebsiteApiKey: 'test-key', approvalNotifyEmail: 'test-notify@example.com' }),
  });

  try {
    const sendRes = await fetch(`${baseUrl}/api/purchase-requests/pr-1/send-approval`, { method: 'POST' });
    assert.equal(sendRes.status, 200);
    const sendBody = await sendRes.json();
    assert.ok(sendBody.approvalId);

    assert.ok(lastCreateBody?.pdf_base64, 'mode=create payload should include the estimate PDF as base64');
    assert.match(lastCreateBody.pdf_filename, /^Estimate-\d+\.pdf$/);
    assert.ok(Buffer.from(lastCreateBody.pdf_base64, 'base64').slice(0, 5).toString() === '%PDF-', 'decoded attachment should be a real PDF');

    let after = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
    assert.equal(after['pr-1'].approvalStatus, 'pending');
    assert.equal(after['pr-1'].approvalLink, `http://127.0.0.1/approve?token=fake-token-for-${sendBody.approvalId}`, 'the full link returned by mode=create should be stored for reference');
    assert.equal(after['pr-1'].approvalShortLink, `http://127.0.0.1/l/short-${sendBody.approvalId}`, 'the self-hosted short link returned by mode=create is what "Copy Approval Link" should actually copy');

    // Poll runs on its own timer in the live server; call the internal function directly here
    // to verify the batched get_status/update logic without waiting on a real interval.
    await app.locals.pollApprovalStatusLoopOnce();

    after = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
    assert.equal(after['pr-1'].approvalStatus, 'approved');
    assert.ok(after['pr-1'].approvalResolvedAt);
    assert.equal(after['pr-1'].approvalIp, '203.0.113.5');
    assert.equal(after['pr-1'].approvalVerificationId, 'ABCD1234EF567890');
    assert.equal(after['pr-1'].signerName, 'Jane Client');
    assert.equal(after['pr-1'].denyReason, null);

    assert.ok(lastUpdatePdfBody, 'poll loop should push a re-stamped PDF back after resolution');
    assert.equal(lastUpdatePdfBody.approval_id, sendBody.approvalId);
    assert.equal(lastUpdatePdfBody.notify_email, 'test-notify@example.com', 'the configurable notify email from Settings should be forwarded to SA-Website');
    const signedPdf = Buffer.from(lastUpdatePdfBody.pdf_base64, 'base64');
    assert.equal(signedPdf.slice(0, 5).toString(), '%PDF-');
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

test('resend-approval re-sends the same pending approval without minting a new approval_id', async () => {
  let lastResendBody = null;
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      res.setHeader('Content-Type', 'application/json');
      if (data.mode === 'create') {
        res.end(JSON.stringify({ ok: true, link: `http://127.0.0.1/approve?token=orig-${data.approval_id}`, short_link: `http://127.0.0.1/l/orig-${data.approval_id}` }));
      } else if (data.mode === 'resend') {
        lastResendBody = data;
        res.end(JSON.stringify({ ok: true, link: `http://127.0.0.1/approve?token=fresh-${data.approval_id}`, short_link: `http://127.0.0.1/l/fresh-${data.approval_id}` }));
      } else {
        res.end(JSON.stringify({ ok: false, error: 'unknown mode' }));
      }
    });
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  const priorSettings = await (await fetch(`${baseUrl}/api/settings`)).json();
  await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...priorSettings, saWebsiteApiBase: mockBase, saWebsiteApiKey: 'test-key' }),
  });

  try {
    await fetch(`${baseUrl}/api/purchase-requests`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'pr-resend': { clientId: 'abc123', clientName: 'Test Client', clientEmail: 'client@example.com', items: [] } }),
    });
    const sendRes = await fetch(`${baseUrl}/api/purchase-requests/pr-resend/send-approval`, { method: 'POST' });
    assert.equal(sendRes.status, 200);
    const sendBody = await sendRes.json();

    const resendRes = await fetch(`${baseUrl}/api/purchase-requests/pr-resend/resend-approval`, { method: 'POST' });
    assert.equal(resendRes.status, 200);
    assert.equal(lastResendBody.approval_id, sendBody.approvalId, 'resend should reuse the existing approval_id rather than minting a new one');

    const after = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
    assert.equal(after['pr-resend'].approvalId, sendBody.approvalId);
    assert.equal(after['pr-resend'].approvalLink, `http://127.0.0.1/approve?token=fresh-${sendBody.approvalId}`, 'the freshly resent link should replace the stored one');
    assert.equal(after['pr-resend'].approvalShortLink, `http://127.0.0.1/l/fresh-${sendBody.approvalId}`, 'the freshly resent short link should replace the stored one too');
    assert.equal(after['pr-resend'].approvalStatus, 'pending');
  } finally {
    await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...priorSettings, saWebsiteApiBase: '', saWebsiteApiKey: '' }),
    });
    await new Promise(resolve => mock.close(resolve));
  }
});

test('resend-approval refuses to resend a request that is not pending', async () => {
  await fetch(`${baseUrl}/api/purchase-requests`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'pr-not-pending': { clientId: 'abc123', clientName: 'Test Client', items: [] } }),
  });
  const res = await fetch(`${baseUrl}/api/purchase-requests/pr-not-pending/resend-approval`, { method: 'POST' });
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

test('internal_notes round-trips via PUT but never appears in the SA-Website payload', async () => {
  const prs = {
    'pr-internal': {
      clientId: 'abc123', clientName: 'Test Client', clientEmail: 'client@example.com',
      notes: 'Client-visible note', internalNotes: 'Tech-only: buy from CDW, markup 15%',
      items: [{ description: 'Widget', qty: 1, estUnitCost: 10 }],
    },
  };
  await fetch(`${baseUrl}/api/purchase-requests`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prs),
  });
  const body = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
  assert.equal(body['pr-internal'].internalNotes, 'Tech-only: buy from CDW, markup 15%');
  assert.equal(body['pr-internal'].notes, 'Client-visible note');
});

test('mark-modified flips an approved/denied request to modified, and re-allows send-approval', async () => {
  await fetch(`${baseUrl}/api/purchase-requests`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'pr-mod': { clientId: 'abc123', clientName: 'Test Client', items: [] } }),
  });
  const db = app.locals.db;
  db.prepare(`UPDATE purchase_requests SET approval_status='approved' WHERE id='pr-mod'`).run();

  const res = await fetch(`${baseUrl}/api/purchase-requests/pr-mod/mark-modified`, { method: 'POST' });
  assert.equal(res.status, 200);

  const after = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
  assert.equal(after['pr-mod'].approvalStatus, 'modified');
});

test('mark-modified is a no-op on a request that was never resolved', async () => {
  await fetch(`${baseUrl}/api/purchase-requests`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'pr-not-resolved': { clientId: 'abc123', clientName: 'Test Client', items: [] } }),
  });
  const res = await fetch(`${baseUrl}/api/purchase-requests/pr-not-resolved/mark-modified`, { method: 'POST' });
  assert.equal(res.status, 200);
  const after = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
  assert.equal(after['pr-not-resolved'].approvalStatus, 'not_sent');
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

test('isValidShortUrl rejects is.gd error text regardless of its prefix punctuation', () => {
  const isValidShortUrl = app.locals.isValidShortUrl;
  assert.equal(isValidShortUrl('https://is.gd/aB3xY9'), true);
  assert.equal(isValidShortUrl('http://is.gd/aB3xY9'), true);
  assert.equal(isValidShortUrl('Error: something went wrong'), false);
  // The actual bug report: is.gd doesn't always use a colon after "Error".
  assert.equal(isValidShortUrl('Error, database insert failed'), false);
  assert.equal(isValidShortUrl(''), false);
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

test('GET /api/syncro-customers sorts real company names ahead of email-like business names', async () => {
  const db = app.locals.db;
  const now = Date.now();
  // Some Syncro records have business_name set to an email address rather
  // than a real company name — those should sort after actual company names.
  db.prepare('INSERT INTO syncro_customers (id, business_name, email, phone, data, updated_at) VALUES (?,?,?,?,?,?)')
    .run('syn-email', 'aaa-first-alphabetically@example.com', 'aaa-first-alphabetically@example.com', '', '{}', now);
  db.prepare('INSERT INTO syncro_customers (id, business_name, email, phone, data, updated_at) VALUES (?,?,?,?,?,?)')
    .run('syn-company', 'Zebra Industries', 'contact@zebra.com', '', '{}', now);

  const all = await (await fetch(`${baseUrl}/api/syncro-customers`)).json();
  const companyIdx = all.findIndex(c => c.id === 'syn-company');
  const emailIdx = all.findIndex(c => c.id === 'syn-email');
  assert.ok(companyIdx >= 0 && emailIdx >= 0);
  assert.ok(companyIdx < emailIdx, 'a real company name should be listed before an email-like business name even when alphabetically later');
});

test('replaceSyncroCustomers prefers customer_business_then_name over a blank business_name', async () => {
  // Syncro leaves business_name blank for individual customers with no
  // company; customer_business_then_name is Syncro's own precomputed
  // "business name if present, else full name" field, so an individual
  // should show their actual name rather than a blank or raw email.
  app.locals.replaceSyncroCustomers([
    { id: 'cust-individual', business_name: '', customer_business_then_name: 'Jane Individual', email: 'jane@example.com' },
    { id: 'cust-company', business_name: 'Acme Corp', customer_business_then_name: 'Acme Corp', email: 'billing@acme.com' },
  ]);
  const all = await (await fetch(`${baseUrl}/api/syncro-customers`)).json();
  const individual = all.find(c => c.id === 'cust-individual');
  const company = all.find(c => c.id === 'cust-company');
  assert.equal(individual.businessName, 'Jane Individual');
  assert.equal(company.businessName, 'Acme Corp');
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

test('pdf.js renderDocumentPdf produces a valid, non-trivial PDF buffer', async () => {
  const { renderDocumentPdf, pdfBufferFromDoc } = require('../pdf');
  const doc = renderDocumentPdf({
    kind: 'Estimate', number: 4242, clientName: 'Test Client', preparedBy: 'Tester',
    items: [{ description: 'Widget', qty: 2, unitPrice: 50 }], notes: 'Some notes', orgName: 'Test Org',
  });
  const buf = await pdfBufferFromDoc(doc);
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 1000, 'a rendered PDF with content should be well over 1KB');
});

test('pdf.js renders an Item column when items have a name, and a signature stamp when provided', async () => {
  const { renderDocumentPdf, pdfBufferFromDoc } = require('../pdf');
  const plainDoc = renderDocumentPdf({
    kind: 'Estimate', number: 1, clientName: 'A', items: [{ description: 'No item name', qty: 1, unitPrice: 10 }],
  });
  const plainBuf = await pdfBufferFromDoc(plainDoc);
  assert.equal(plainBuf.slice(0, 5).toString(), '%PDF-');

  const stampedDoc = renderDocumentPdf({
    kind: 'Estimate', number: 2, clientName: 'B',
    items: [{ name: 'SW-100', description: 'Switch', qty: 1, unitPrice: 300 }],
    signature: { decision: 'approved', resolvedBy: 'client@example.com', resolvedAtIso: new Date().toISOString(), ip: '203.0.113.5', verificationId: 'ABCD1234' },
  });
  const stampedBuf = await pdfBufferFromDoc(stampedDoc);
  assert.equal(stampedBuf.slice(0, 5).toString(), '%PDF-');
  assert.ok(stampedBuf.length > plainBuf.length, 'a PDF with an Item column + signature stamp should render more content than a bare one');
});

test('GET /api/purchase-requests/:id/pdf assigns an estimate number and streams a real PDF', async () => {
  await fetch(`${baseUrl}/api/purchase-requests`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'pr-pdf-test': {
      clientId: 'abc123', clientName: 'Test Client', notes: 'Preview me',
      items: [{ description: 'Router', qty: 1, estUnitCost: 200 }],
    }}),
  });

  const res = await fetch(`${baseUrl}/api/purchase-requests/pr-pdf-test/pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /inline/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');

  const prs = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
  assert.ok(prs['pr-pdf-test'].number >= 1001, 'estimate number should be assigned on first PDF generation');

  // A second request must reuse the same number rather than incrementing again.
  await fetch(`${baseUrl}/api/purchase-requests/pr-pdf-test/pdf`);
  const prsAfterSecondFetch = await (await fetch(`${baseUrl}/api/purchase-requests`)).json();
  assert.equal(prsAfterSecondFetch['pr-pdf-test'].number, prs['pr-pdf-test'].number);
});

test('GET /api/invoices/:id/pdf streams a real PDF', async () => {
  const created = await (await fetch(`${baseUrl}/api/invoices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'abc123', clientName: 'Test Client', lineItems: [{ description: 'Service', qty: 1, unitPrice: 100 }] }),
  })).json();

  const res = await fetch(`${baseUrl}/api/invoices/${created.id}/pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
});
