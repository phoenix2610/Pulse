import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { checkHttp, statusMatcher, jsonPath } from '../server/checks/http.js';
import { checkTcp } from '../server/checks/tcp.js';
import { checkPush } from '../server/checks/index.js';
import { targetServer } from './helpers.js';

test('statusMatcher handles ranges and lists', () => {
  const m = statusMatcher('200-299, 404');
  assert.ok(m(200) && m(299) && m(404));
  assert.ok(!m(500) && !m(301));
  assert.throws(() => statusMatcher('abc'));
});

test('jsonPath resolves nested and indexed paths', () => {
  const o = { data: { items: [{ s: 'ok' }, { s: 'bad' }] }, n: null };
  assert.equal(jsonPath(o, 'data.items[1].s'), 'bad');
  assert.equal(jsonPath(o, '$.data.items[0].s'), 'ok');
  assert.equal(jsonPath(o, 'data.missing.deep'), undefined);
  assert.equal(jsonPath(o, 'n.x'), undefined);
});

test('http: success reports timings and status', async () => {
  const t = await targetServer((req, res) => res.end('hello world'));
  const r = await checkHttp({ url: t.url });
  assert.equal(r.ok, true);
  assert.equal(r.statusCode, 200);
  assert.ok(r.meta.timings.total >= 0 && r.meta.timings.ttfb >= 0);
  await t.close();
});

test('http: unexpected status fails with a clear message', async () => {
  const t = await targetServer((req, res) => { res.statusCode = 503; res.end('down'); });
  const r = await checkHttp({ url: t.url, expectedStatus: '200-299' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Unexpected status 503/);
  assert.equal((await checkHttp({ url: t.url, expectedStatus: '503' })).ok, true);
  await t.close();
});

test('http: keyword present / absent modes', async () => {
  const t = await targetServer((req, res) => res.end('<h1>Welcome</h1> maintenance-free'));
  assert.equal((await checkHttp({ url: t.url, keyword: 'Welcome' })).ok, true);
  assert.match((await checkHttp({ url: t.url, keyword: 'Goodbye' })).error, /not found/);
  assert.match((await checkHttp({ url: t.url, keyword: 'Welcome', keywordMode: 'absent' })).error, /Forbidden keyword/);
  await t.close();
});

test('http: JSON path assertions', async () => {
  const t = await targetServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', db: { latency: 3 } })); });
  assert.equal((await checkHttp({ url: t.url, jsonPath: 'status', jsonExpected: 'ok' })).ok, true);
  assert.match((await checkHttp({ url: t.url, jsonPath: 'status', jsonExpected: 'degraded' })).error, /expected degraded/);
  assert.match((await checkHttp({ url: t.url, jsonPath: 'nope' })).error, /not found/);
  await t.close();
});

test('http: follows redirects, and can be told not to', async () => {
  const t = await targetServer((req, res) => {
    if (req.url === '/') { res.statusCode = 302; res.setHeader('location', '/final'); res.end(); } else res.end('done');
  });
  const r = await checkHttp({ url: t.url });
  assert.equal(r.ok, true);
  assert.equal(r.meta.redirects, 1);
  const r2 = await checkHttp({ url: t.url, followRedirects: false, expectedStatus: '200-299' });
  assert.equal(r2.ok, false);
  await t.close();
});

test('http: redirect loops are cut off', async () => {
  const t = await targetServer((req, res) => { res.statusCode = 302; res.setHeader('location', '/'); res.end(); });
  assert.match((await checkHttp({ url: t.url })).error, /Too many redirects/);
  await t.close();
});

test('http: timeout and connection refused', async () => {
  const t = await targetServer(() => {   });
  const r = await checkHttp({ url: t.url }, { timeoutMs: 150 });
  assert.equal(r.ok, false);
  assert.match(r.error, /Timed out/);
  await t.close();
  assert.match((await checkHttp({ url: t.url }, { timeoutMs: 1000 })).error, /refused/i);
});

test('http: max latency budget', async () => {
  const t = await targetServer((req, res) => setTimeout(() => res.end('slow'), 60));
  assert.match((await checkHttp({ url: t.url, maxLatencyMs: 20 })).error, /Too slow/);
  assert.equal((await checkHttp({ url: t.url, maxLatencyMs: 2000 })).ok, true);
  await t.close();
});

test('http: sends method, headers, body', async () => {
  let seen;
  const t = await targetServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { seen = { m: req.method, h: req.headers['x-token'], b }; res.end('ok'); }); });
  await checkHttp({ url: t.url, method: 'POST', headers: { 'x-token': 'abc' }, body: '{"a":1}' });
  assert.deepEqual(seen, { m: 'POST', h: 'abc', b: '{"a":1}' });
  await t.close();
});

test('tcp: connect-only, banner matching, refused', async () => {
  const open = net.createServer((s) => { s.on('error', () => {}); s.write('220 smtp.test ESMTP\r\n'); });
  await new Promise((r) => open.listen(0, '127.0.0.1', r));
  const { port } = open.address();
  assert.equal((await checkTcp({ host: '127.0.0.1', port })).ok, true);
  assert.equal((await checkTcp({ host: '127.0.0.1', port, expectBanner: 'ESMTP' })).ok, true);
  const bad = net.createServer((s) => { s.on('error', () => {}); s.end('HTTP/1.1 400\r\n'); });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  assert.match((await checkTcp({ host: '127.0.0.1', port: bad.address().port, expectBanner: 'ESMTP' })).error, /Closed before banner|did not contain/);
  open.closeAllConnections?.();
  await new Promise((r) => open.close(r));
  bad.close();
  assert.match((await checkTcp({ host: '127.0.0.1', port })).error, /refused/i);
});

test('push monitor: waiting, fresh, stale, self-reported failure', () => {
  const base = { interval_s: 60, created_at: Date.now(), last_push_at: null, last_push_ok: 1 };
  assert.equal(checkPush(base, { graceS: 30 }).ok, true);  
  assert.equal(checkPush({ ...base, created_at: Date.now() - 200_000 }, { graceS: 30 }).ok, false);
  assert.equal(checkPush({ ...base, last_push_at: Date.now() - 10_000 }, { graceS: 30 }).ok, true);
  assert.match(checkPush({ ...base, last_push_at: Date.now() - 100_000 }, { graceS: 30 }).error, /No heartbeat for/);
  assert.match(checkPush({ ...base, last_push_at: Date.now() - 1000, last_push_ok: 0, last_push_msg: 'disk full' }, {}).error, /disk full/);
});
