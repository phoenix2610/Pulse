import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, targetServer } from './helpers.js';

const httpMonitor = (url, extra = {}) => ({ name: 'Web', type: 'http', config: { url }, intervalS: 30, timeoutMs: 2000, ...extra });

test('first-run setup flow and auth guards', async () => {
  const { client, stop } = await makeApp();
  assert.deepEqual((await client.get('/api/setup/status')).json, { needsSetup: true });
  assert.equal((await client.get('/api/monitors')).status, 401);
  const bad = await client.post('/api/setup', { email: 'nope', name: '', password: 'short' });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.details.email && bad.json.details.password && bad.json.details.name);
  assert.equal((await client.setup()).status, 201);
  assert.equal((await client.get('/api/auth/me')).json.user.email, 'admin@test.dev');
  assert.equal((await client.post('/api/setup', { email: 'b@b.co', name: 'B', password: 'password-123' })).status, 409);
  assert.deepEqual((await client.get('/api/setup/status')).json, { needsSetup: false });
  await stop();
});

test('login, logout, wrong password, and rate limiting', async () => {
  const { client, base, stop } = await makeApp();
  await client.setup();
  await client.post('/api/auth/logout');
  assert.equal((await client.get('/api/auth/me')).status, 401);
  const c2 = new (client.constructor)(base);
  assert.equal((await c2.post('/api/auth/login', { email: 'admin@test.dev', password: 'wrong-password' })).status, 401);
  assert.equal((await c2.post('/api/auth/login', { email: 'ghost@test.dev', password: 'whatever-1' })).status, 401);
  assert.equal((await c2.post('/api/auth/login', { email: 'ADMIN@test.dev', password: 'correct-horse-1' })).status, 200);
  assert.equal((await c2.get('/api/auth/me')).status, 200);
  let last;
  for (let i = 0; i < 12; i++) last = await new (client.constructor)(base).post('/api/auth/login', { email: 'admin@test.dev', password: 'nope-nope-1' });
  assert.equal(last.status, 429);
  await stop();
});

test('csrf: cross-origin and non-JSON cookie writes are rejected', async () => {
  const { client, stop } = await makeApp();
  await client.setup();
  const evil = await client.req('POST', '/api/monitors', httpMonitor('http://x.test'), { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const form = await client.req('POST', '/api/monitors', 'name=x', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415);
  await stop();
});

test('monitor CRUD with validation', async () => {
  const { client, stop } = await makeApp();
  await client.setup();
  const bad = await client.post('/api/monitors', { name: '', type: 'http', config: { url: 'ftp://x' }, intervalS: 5 });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.details.name && bad.json.details['config.url'] && bad.json.details.intervalS);
  assert.equal((await client.post('/api/monitors', httpMonitor('http://x.test', { timeoutMs: 60000, intervalS: 30 }))).status, 422);  

  const created = await client.post('/api/monitors', httpMonitor('http://x.test', { tags: ['a', 'b'], group: 'Core' }));
  assert.equal(created.status, 201);
  const id = created.json.id;
  assert.equal(created.json.config.expectedStatus, '200-399');  
  assert.equal(created.json.group, 'Core');

  const upd = await client.put(`/api/monitors/${id}`, { name: 'Renamed', intervalS: 120 });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.name, 'Renamed');
  assert.equal(upd.json.config.url, 'http://x.test');
  assert.equal(upd.json.intervalS, 120);

  const list = await client.get('/api/monitors?q=renam');
  assert.equal(list.json.monitors.length, 1);
  assert.deepEqual(list.json.groups, ['Core']);
  assert.equal((await client.get('/api/monitors?q=zzz')).json.monitors.length, 0);

  assert.equal((await client.post(`/api/monitors/${id}/pause`)).json.status, 'paused');
  assert.equal((await client.post(`/api/monitors/${id}/run`)).status, 409);
  assert.equal((await client.post(`/api/monitors/${id}/resume`)).json.status, 'pending');
  assert.equal((await client.del(`/api/monitors/${id}`)).status, 200);
  assert.equal((await client.get(`/api/monitors/${id}`)).status, 404);
  await stop();
});

test('run-now executes a real check and updates state + stats', async () => {
  const target = await targetServer((req, res) => res.end('alive'));
  const { client, stop } = await makeApp();
  await client.setup();
  const { json: m } = await client.post('/api/monitors', httpMonitor(target.url));
  const run = await client.post(`/api/monitors/${m.id}/run`);
  assert.equal(run.json.result.ok, true);
  assert.equal(run.json.monitor.status, 'up');
  target.state.handler = (req, res) => { res.statusCode = 500; res.end('x'); };
  await client.put(`/api/monitors/${m.id}`, { retries: 1 });
  const run2 = await client.post(`/api/monitors/${m.id}/run`);
  assert.equal(run2.json.monitor.status, 'down');
  assert.match(run2.json.monitor.lastError, /500/);
  const checks = await client.get(`/api/monitors/${m.id}/checks`);
  assert.equal(checks.json.checks.length, 2);
  assert.equal(checks.json.checks[0].ok, false);
  const stats = await client.get(`/api/monitors/${m.id}/stats?range=24h`);
  assert.equal(stats.json.uptime['24h'], 50);
  const inc = await client.get('/api/incidents?status=open');
  assert.equal(inc.json.total, 1);
  assert.equal(inc.json.incidents[0].monitorName, 'Web');
  const summary = await client.get('/api/summary');
  assert.equal(summary.json.counts.down, 1);
  assert.equal(summary.json.openIncidents.length, 1);
  await target.close();
  await stop();
});

test('dry-run test endpoint does not persist anything', async () => {
  const target = await targetServer();
  const { client, stop } = await makeApp();
  await client.setup();
  const r = await client.post('/api/monitors/test', httpMonitor(target.url));
  assert.equal(r.json.result.ok, true);
  assert.equal((await client.get('/api/monitors')).json.monitors.length, 0);
  await target.close();
  await stop();
});

test('incident workflow: acknowledge, comment, timeline', async () => {
  const { client, app, stop } = await makeApp();
  await client.setup();
  const { json: m } = await client.post('/api/monitors', httpMonitor('http://x.test', { retries: 1 }));
  app.pipeline.handleResult(m.id, { ok: false, error: 'kaput' });
  const { json: list } = await client.get('/api/incidents');
  const id = list.incidents[0].id;
  assert.equal((await client.post(`/api/incidents/${id}/ack`)).json.ackBy, 'Admin');
  assert.equal((await client.post(`/api/incidents/${id}/comments`, { message: 'looking into it' })).status, 201);
  assert.equal((await client.post(`/api/incidents/${id}/comments`, { message: '' })).status, 422);
  const detail = (await client.get(`/api/incidents/${id}`)).json;
  assert.deepEqual(detail.events.map((e) => e.kind), ['opened', 'ack', 'comment']);
  app.pipeline.handleResult(m.id, { ok: true, latencyMs: 3 });
  assert.equal((await client.post(`/api/incidents/${id}/ack`)).status, 409);  
  assert.equal((await client.get(`/api/incidents/${id}`)).json.open, false);
  await stop();
});

test('heartbeat (push) monitors: token URL, failure reports, staleness', async () => {
  const { client, app, stop } = await makeApp();
  await client.setup();
  const { json: m } = await client.post('/api/monitors', { name: 'cron', type: 'push', config: { graceS: 0 }, intervalS: 60, retries: 1 });
  assert.ok(m.pushToken);
  const anon = new (client.constructor)(client.base);
  assert.equal((await anon.get('/api/push/not-a-token')).status, 404);
  assert.equal((await anon.get(`/api/push/${m.pushToken}?ping=120`)).status, 200);  
  assert.equal((await client.get(`/api/monitors/${m.id}`)).json.status, 'up');
  await anon.post(`/api/push/${m.pushToken}?status=down&msg=disk%20full`);
  const bad = (await client.get(`/api/monitors/${m.id}`)).json;
  assert.equal(bad.status, 'down');
  assert.equal(bad.lastError, 'disk full');
  await anon.get(`/api/push/${m.pushToken}`);
  assert.equal((await client.get(`/api/monitors/${m.id}`)).json.status, 'up');
   
  app.db.prepare('UPDATE monitors SET last_push_at = ? WHERE id = ?').run(Date.now() - 300_000, m.id);
  const r = await app.scheduler.runNow(m.id);
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /No heartbeat/);
  await stop();
});

test('API tokens: bearer auth, read-only scope, revocation', async () => {
  const { client, base, stop } = await makeApp();
  await client.setup();
  const rw = (await client.post('/api/tokens', { name: 'ci' })).json;
  const ro = (await client.post('/api/tokens', { name: 'grafana', readOnly: true })).json;
  assert.match(rw.secret, /^pls_/);
  assert.equal((await client.get('/api/tokens')).json.length, 2);
  const c = new (client.constructor)(base);
  c.token = rw.secret;
  assert.equal((await c.post('/api/monitors', httpMonitor('http://x.test'))).status, 201);
  const r = new (client.constructor)(base);
  r.token = ro.secret;
  assert.equal((await r.get('/api/monitors')).status, 200);
  assert.equal((await r.post('/api/monitors', httpMonitor('http://y.test'))).status, 403);
  await client.del(`/api/tokens/${rw.id}`);
  assert.equal((await c.get('/api/monitors')).status, 401);
  const junk = new (client.constructor)(base); junk.token = 'pls_bogus';
  assert.equal((await junk.get('/api/monitors')).status, 401);
  await stop();
});

test('channels: secrets are masked and preserved on update', async () => {
  const { client, stop } = await makeApp();
  await client.setup();
  const { json: ch } = await client.post('/api/channels', { name: 'Ops', type: 'webhook', config: { url: 'https://hooks.example.com/abc/def', secret: 'topsecret' } });
  assert.equal(ch.config.secret, '••••••••');
  assert.ok(!JSON.stringify(ch).includes('abc/def'));
  const upd = await client.put(`/api/channels/${ch.id}`, { name: 'Ops 2', config: ch.config });
  assert.equal(upd.status, 200);
  const stored = (await import('../server/util.js')).parseJson(stop.app?.models?.channels?.row(ch.id)?.config);
  void stored;
  assert.equal((await client.post('/api/channels', { name: 'x', type: 'ntfy', config: { topic: 'bad topic!' } })).status, 422);
  assert.equal((await client.post('/api/channels', { name: 'x', type: 'carrier-pigeon', config: {} })).status, 422);
  await stop();
});

test('channel secrets survive a masked round-trip (verified in DB)', async () => {
  const { client, app, stop } = await makeApp();
  await client.setup();
  const { json: ch } = await client.post('/api/channels', { name: 'Ops', type: 'webhook', config: { url: 'https://hooks.example.com/abc/def', secret: 'topsecret' } });
  await client.put(`/api/channels/${ch.id}`, { config: ch.config });
  const cfg = JSON.parse(app.models.channels.row(ch.id).config);
  assert.equal(cfg.secret, 'topsecret');
  assert.equal(cfg.url, 'https://hooks.example.com/abc/def');
  await stop();
});

test('channel test button delivers via the notifier', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push([url, JSON.parse(init.body)]); return new Response(null, { status: 204 }); };
  const { client, stop } = await makeApp({}, { fetchImpl });
  await client.setup();
  const { json: ch } = await client.post('/api/channels', { name: 'D', type: 'discord', config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' } });
  const r = await client.post(`/api/channels/${ch.id}/test`);
  assert.equal(r.json.ok, true);
  assert.equal(sent[0][1].embeds[0].title, '🔔 Pulse test notification');
  await stop();
});

test('status page: public JSON, reserved slugs, badges, hidden monitors stay hidden', async () => {
  const { client, app, stop } = await makeApp();
  await client.setup();
  const a = (await client.post('/api/monitors', httpMonitor('http://a.test', { name: 'Public API', retries: 1 }))).json;
  const b = (await client.post('/api/monitors', httpMonitor('http://b.test', { name: 'Secret Internal' }))).json;
  assert.equal((await client.post('/api/status-pages', { slug: 'api', title: 'x', monitors: [] })).status, 422);
  assert.equal((await client.post('/api/status-pages', { slug: 'Bad Slug', title: 'x' })).status, 422);
  const page = await client.post('/api/status-pages', { slug: 'acme', title: 'Acme', monitors: [{ monitorId: a.id, label: 'API' }] });
  assert.equal(page.status, 201);
  assert.equal((await client.post('/api/status-pages', { slug: 'acme', title: 'dup' })).status, 409);
  app.pipeline.handleResult(a.id, { ok: true, latencyMs: 10 });
  const anon = new (client.constructor)(client.base);
  const pub = (await anon.get('/api/public/status/acme')).json;
  assert.equal(pub.overall, 'operational');
  assert.equal(pub.monitors.length, 1);
  assert.equal(pub.monitors[0].name, 'API');
  assert.ok(!JSON.stringify(pub).includes('Secret Internal'));
  assert.equal(pub.monitors[0].bars.length, 90);
  app.pipeline.handleResult(a.id, { ok: false, error: 'bad' });
  assert.equal((await anon.get('/api/public/status/acme')).json.overall, 'outage');
  const svg = await anon.get(`/badge/${a.id}/status.svg`);
  assert.match(svg.headers.get('content-type'), /svg/);
  assert.match(svg.text, /down/);
  assert.equal((await anon.get(`/badge/${b.id}/status.svg`)).status, 404);  
  assert.equal((await anon.get('/api/public/status/none')).status, 404);
  await client.post(`/api/status-pages/${page.json.id}/announcements`, { title: 'Investigating elevated errors', level: 'warning' });
  assert.equal((await anon.get('/api/public/status/acme')).json.announcements[0].level, 'warning');
  await stop();
});

test('maintenance API validates ranges and drives monitor status', async () => {
  const { client, app, stop } = await makeApp();
  await client.setup();
  const m = (await client.post('/api/monitors', httpMonitor('http://a.test', { retries: 1 }))).json;
  const now = Date.now();
  assert.equal((await client.post('/api/maintenance', { name: 'x', startsAt: now + 100, endsAt: now })).status, 422);
  const w = await client.post('/api/maintenance', { name: 'deploy', startsAt: now - 1000, endsAt: now + 60_000, monitorIds: [m.id] });
  assert.equal(w.status, 201);
  assert.equal(w.json.state, 'active');
  app.pipeline.handleResult(m.id, { ok: false, error: 'deploying' });
  assert.equal((await client.get(`/api/monitors/${m.id}`)).json.status, 'maintenance');
  assert.equal((await client.get('/api/incidents')).json.total, 0);
  await stop();
});

test('export → import round-trips config and remaps channel refs', async () => {
  const a = await makeApp();
  await a.client.setup();
  const ch = (await a.client.post('/api/channels', { name: 'Ops', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' } })).json;
  const m = (await a.client.post('/api/monitors', httpMonitor('http://a.test', { name: 'One', channelIds: [ch.id], tags: ['x'] }))).json;
  await a.client.post('/api/status-pages', { slug: 'pg', title: 'PG', monitors: [{ monitorId: m.id }] });
  const dump = (await a.client.get('/api/export')).json;
  assert.equal(dump.monitors.length, 1);
  const b = await makeApp();
  await b.client.setup();
  const res = await b.client.post('/api/import', dump);
  assert.deepEqual(res.json.imported, { channels: 1, monitors: 1, statusPages: 1 });
  const list = (await b.client.get('/api/monitors')).json.monitors;
  assert.equal(list[0].name, 'One');
  assert.equal(list[0].channelIds.length, 1);
  assert.equal((await b.client.post('/api/import', { nope: true })).status, 422);
  await a.stop(); await b.stop();
});

test('static files: SPA fallback, gzip, etag, traversal blocked', async () => {
  const { client, base, stop } = await makeApp();
  const index = await fetch(`${base}/`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /html/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  const etag = index.headers.get('etag');
  assert.equal((await fetch(`${base}/`, { headers: { 'if-none-match': etag } })).status, 304);
  assert.equal((await fetch(`${base}/some/spa/route`)).status, 200);  
  assert.equal((await fetch(`${base}/js/does-not-exist.js`)).status, 404);
  const trav = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.notEqual(trav.headers.get('content-type'), 'application/json');
  assert.equal((await fetch(`${base}/status/acme`)).status, 200);  
  assert.equal((await client.get('/nope')).status, 200);
  await stop();
});

test('SSE stream delivers live check events', async () => {
  const { client, app, stop } = await makeApp();
  await client.setup();
  const m = (await client.post('/api/monitors', httpMonitor('http://a.test'))).json;
  const ac = new AbortController();
  const res = await fetch(`${client.base}/api/events`, { headers: { cookie: client.cookie }, signal: ac.signal });
  assert.match(res.headers.get('content-type'), /event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const read = async (needle) => { while (!buf.includes(needle)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } };
  await read('event: hello');
  app.pipeline.handleResult(m.id, { ok: true, latencyMs: 42 });
  await read('event: check');
  assert.match(buf, /"latencyMs":42/);
  ac.abort();
  await stop();
});
