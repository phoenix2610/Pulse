import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

 
async function setup({ retries = 2 } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), headers: init.headers }); return new Response('ok', { status: 200 }); };
  const ctx = await makeApp({}, { fetchImpl });
  const { models, pipeline } = ctx.app;
  const chId = models.channels.create({ name: 'hook', type: 'webhook', config: { url: 'https://hooks.test/x', secret: 's3cret' } });
  const id = models.monitors.create({ name: 'svc', type: 'http', config: { url: 'http://x' }, intervalS: 60, timeoutMs: 1000, retries, channelIds: [chId] });
  const ok = (ts) => pipeline.handleResult(id, { ok: true, latencyMs: 20 }, ts);
  const bad = (ts, error = 'boom') => pipeline.handleResult(id, { ok: false, error }, ts);
  const flush = () => new Promise((r) => setTimeout(r, 30));
  return { ...ctx, models, id, ok, bad, sent, flush, chId };
}

test('first success moves pending → up without an incident', async () => {
  const t = await setup();
  const r = t.ok(Date.now());
  assert.equal(r.status, 'up');
  assert.equal(t.models.incidents.countOpen(), 0);
  await t.stop();
});

test('failures below the retry threshold stay pending; threshold opens one incident', async () => {
  const t = await setup({ retries: 3 });
  t.ok(1000);
  assert.equal(t.bad(2000).status, 'pending');
  assert.equal(t.bad(3000).status, 'pending');
  const r = t.bad(4000);
  assert.equal(r.status, 'down');
  assert.equal(r.transition, 'down');
  assert.equal(t.models.incidents.countOpen(), 1);
   
  t.bad(5000); t.bad(6000);
  assert.equal(t.models.incidents.list({}).total, 1);
  await t.stop();
});

test('a single blip inside the retry window never alerts', async () => {
  const t = await setup({ retries: 2 });
  t.ok(1000); t.bad(2000);
  const r = t.ok(3000);
  assert.equal(r.status, 'up');
  assert.equal(t.models.incidents.list({}).total, 0);
  await t.flush();
  assert.equal(t.sent.length, 0);
  await t.stop();
});

test('recovery resolves the incident and notifies down then up', async () => {
  const t = await setup({ retries: 1 });
  t.ok(1000);
  t.bad(2000, 'Unexpected status 500');
  await t.flush();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].body.event, 'down');
  assert.match(t.sent[0].body.message, /Unexpected status 500/);
  const r = t.ok(62_000);
  assert.equal(r.transition, 'recovered');
  await t.flush();
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1].body.event, 'up');
  const inc = t.models.incidents.list({}).rows[0];
  assert.equal(inc.resolved_at, 62_000);
  const kinds = t.models.incidents.events(inc.id).map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k !== 'notified'), ['opened', 'resolved']);
  await t.stop();
});

test('webhook payloads are HMAC-signed', async () => {
  const { hmac } = await import('../server/util.js');
  const t = await setup({ retries: 1 });
  t.bad(1000);
  await t.flush();
  assert.match(t.sent[0].headers['x-pulse-signature'], /^sha256=[0-9a-f]{64}$/);
  await t.stop();
});

test('maintenance windows suppress incidents and alerts, and are excluded from uptime', async () => {
  const t = await setup({ retries: 1 });
  const now = Date.now();
  t.ok(now - 5000);
  t.models.maintenance.create({ name: 'db upgrade', startsAt: now - 1000, endsAt: now + 600_000, monitorIds: [t.id] });
  const r = t.bad(now);
  assert.equal(r.status, 'maintenance');
  assert.equal(t.models.incidents.countOpen(), 0);
  await t.flush();
  assert.equal(t.sent.length, 0);
   
  const rollup = t.models.checks.rollupRange(t.id, 0, now + 1);
  assert.equal(rollup.reduce((s, x) => s + x.total, 0), 1);
  await t.stop();
});

test('an incident survives a maintenance window and does not duplicate afterwards', async () => {
  const t = await setup({ retries: 1 });
  const now = Date.now();
  t.ok(now - 10_000);
  t.bad(now - 9000);
  assert.equal(t.models.incidents.countOpen(), 1);
  const mid = t.models.maintenance.create({ name: 'w', startsAt: now - 8000, endsAt: now - 4000, monitorIds: [] });
  t.bad(now - 7000);
  t.models.maintenance.remove(mid);
  t.bad(now - 1000);  
  assert.equal(t.models.incidents.list({}).total, 1);
  t.ok(now);
  assert.equal(t.models.incidents.countOpen(), 0);
  await t.stop();
});

test('paused monitors ignore results', async () => {
  const t = await setup();
  t.models.monitors.setEnabled(t.id, false);
  assert.equal(t.ok(1000), null);
  assert.equal(t.models.checks.recent(t.id).length, 0);
  await t.stop();
});

test('cert expiry alert fires once per day', async () => {
  const t = await setup();
  const soon = Date.now() + 3 * 86400_000;
  const beat = (ts) => t.app.pipeline.handleResult(t.id, { ok: true, latencyMs: 5, certExpiresAt: soon }, ts);
  const now = Date.now();
  beat(now); beat(now + 1000); beat(now + 2000);
  await t.flush();
  const certs = t.sent.filter((s) => s.body.event === 'cert');
  assert.equal(certs.length, 1);
  assert.match(certs[0].body.message, /expires in 2 days|expires in 3 days/);
  beat(now + 25 * 3600_000);
  await t.flush();
  assert.equal(t.sent.filter((s) => s.body.event === 'cert').length, 2);
  await t.stop();
});

test('failed deliveries are logged and retried without blocking', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('nope', { status: 500 }); };
  const { app, stop } = await makeApp({ notifyBackoffMs: 20 }, { fetchImpl });
  const { models, pipeline } = app;
  models.channels.create({ name: 'h', type: 'webhook', config: { url: 'https://hooks.test/x' }, applyAll: true });
  const id = models.monitors.create({ name: 'a', type: 'http', config: { url: 'http://x' }, intervalS: 60, timeoutMs: 1000, retries: 1 });
  const t0 = Date.now();
  pipeline.handleResult(id, { ok: false, error: 'x' });
  assert.ok(Date.now() - t0 < 100, 'handleResult must not await delivery');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls, 3);
  const log = models.channels.recentLog();
  assert.equal(log[0].ok, false);
  assert.match(log[0].error, /HTTP 500/);
  await stop();
});
