const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

let server, baseUrl, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-test-'));
  process.env.DATA_DIR = dataDir;
  const app = require('../server.js');
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
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
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
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
