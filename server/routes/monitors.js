import { validate } from '../validate.js';
import { HttpError, notFound, DAY } from '../util.js';
import { CHECK_TYPES } from '../checks/index.js';
import { statusMatcher } from '../checks/http.js';
import { RANGE_KEYS } from '../stats.js';

const HOST = { type: 'string', required: true, min: 1, max: 253, pattern: /^[A-Za-z0-9]([A-Za-z0-9.\-:]*[A-Za-z0-9])?$/, message: 'must be a hostname or IP' };
const PORT = { type: 'int', required: true, min: 1, max: 65535 };

export const CONFIG_SCHEMAS = {
  http: {
    url: { type: 'url', required: true, max: 2000 },
    method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], default: 'GET' },
    headers: { type: 'record', max: 30 },
    body: { type: 'string', max: 100_000, trim: false },
    expectedStatus: { type: 'string', default: '200-399', max: 100 },
    keyword: { type: 'string', max: 500, trim: false },
    keywordMode: { type: 'string', enum: ['contains', 'absent'], default: 'contains' },
    jsonPath: { type: 'string', max: 200 },
    jsonExpected: { type: 'string', max: 500, trim: false },
    followRedirects: { type: 'bool', default: true },
    ignoreTls: { type: 'bool', default: false },
    maxLatencyMs: { type: 'int', min: 1, max: 600_000 },
  },
  tcp: { host: HOST, port: PORT, send: { type: 'string', max: 500, trim: false }, expectBanner: { type: 'string', max: 200, trim: false } },
  dns: {
    host: HOST,
    recordType: { type: 'string', enum: ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA'], default: 'A' },
    expected: { type: 'string', max: 500 },
    nameserver: { type: 'string', max: 100, pattern: /^[0-9a-fA-F.:]+$/, message: 'must be an IP address' },
  },
  tls: { host: HOST, port: { type: 'int', min: 1, max: 65535, default: 443 }, warnDays: { type: 'int', min: 1, max: 365, default: 14 }, ignoreTls: { type: 'bool', default: false } },
  ping: { host: HOST, count: { type: 'int', min: 1, max: 5, default: 1 } },
  push: { graceS: { type: 'int', min: 0, max: 86400, default: 30 } },
};

export const monitorSchema = {
  name: { type: 'string', required: true, min: 1, max: 100 },
  type: { type: 'string', required: true, enum: CHECK_TYPES },
  config: { type: 'object' },
  intervalS: { type: 'int', min: 10, max: 86400, default: 60 },
  timeoutMs: { type: 'int', min: 500, max: 60_000, default: 10_000 },
  retries: { type: 'int', min: 1, max: 10, default: 2 },
  enabled: { type: 'bool', default: true },
  group: { type: 'string', max: 60, nullable: true },
  tags: { type: 'array', max: 10, items: { type: 'string', min: 1, max: 30 }, default: () => [] },
  channelIds: { type: 'array', max: 50, items: { type: 'int', min: 1 } },
};

 
export function parseMonitorInput(body, { partial = false, existing = null } = {}) {
  const errors = {};
  let input = {};
  try { input = validate(monitorSchema, body, { partial }); } catch (e) {
    if (e instanceof HttpError && e.details) Object.assign(errors, e.details); else throw e;
  }
   
  const type = input.type ?? (typeof body?.type === 'string' ? body.type : undefined) ?? existing?.type;
  if (type && CONFIG_SCHEMAS[type]) {
    const cfgIn = body?.config ?? (partial ? existing?.config : undefined) ?? {};
    try {
      input.config = validate(CONFIG_SCHEMAS[type], cfgIn, { path: 'config' });
      if (type === 'http') {
        try { statusMatcher(input.config.expectedStatus); } catch (e) { errors['config.expectedStatus'] = e.message; }
      }
    } catch (e) {
      if (e instanceof HttpError && e.details) Object.assign(errors, e.details); else throw e;
    }
  }
  const interval = input.intervalS ?? existing?.intervalS;
  const timeout = input.timeoutMs ?? existing?.timeoutMs;
  if (interval && timeout && timeout > interval * 1000 && !errors.timeoutMs) errors.timeoutMs = 'must not exceed the check interval';
  if (Object.keys(errors).length) throw new HttpError(422, 'Validation failed', errors);
  return input;
}

export function monitorRoutes({ router, models, auth, stats, scheduler, pipeline }) {
  const { monitors, checks, incidents, channels } = models;

  const decorate = (row, { detail = false } = {}) => {
    const openInc = incidents.openFor(row.id);
    const extra = {
      uptime24h: stats.uptime(row.id, DAY),
      sparkline: checks.sparkline(row.id, detail ? 90 : 40),
      openIncidentId: openInc?.id ?? null,
      channelIds: monitors.channelIds(row.id),
      maintenance: !!models.maintenance.activeFor(row.id),
    };
    return monitors.out(row, extra);
  };
  const need = (id) => { const r = monitors.row(Number(id)); if (!r) throw notFound('Monitor'); return r; };
  const validChannels = (ids) => {
    for (const id of ids ?? []) if (!channels.row(id)) throw new HttpError(422, 'Validation failed', { channelIds: `channel ${id} does not exist` });
  };

  router.get('/api/monitors', auth.requireAuth, (ctx) => {
    const { q, status, group, tag } = ctx.query;
    let rows = monitors.listRows();
    if (status) rows = rows.filter((r) => r.status === status);
    if (group) rows = rows.filter((r) => r.group_name === group);
    if (tag) rows = rows.filter((r) => JSON.parse(r.tags).includes(tag));
    if (q) { const n = q.toLowerCase(); rows = rows.filter((r) => r.name.toLowerCase().includes(n) || r.config.toLowerCase().includes(n)); }
    return { monitors: rows.map((r) => decorate(r)), groups: monitors.groups() };
  });

  router.post('/api/monitors', auth.requireAuth, (ctx) => {
    const input = parseMonitorInput(ctx.body);
    validChannels(input.channelIds);
    const id = monitors.create(input);
    if (input.enabled) scheduler.reschedule(id, 100);
    ctx.status = 201;
    return decorate(monitors.row(id));
  });

  router.get('/api/monitors/:id', auth.requireAuth, (ctx) => {
    const row = need(ctx.params.id);
    return { ...decorate(row, { detail: true }), uptime: stats.uptimeSummary(row.id), incidentStats: stats.incidentStats(row.id) };
  });

  router.put('/api/monitors/:id', auth.requireAuth, (ctx) => {
    const row = need(ctx.params.id);
    const existing = monitors.out(row);
    const input = parseMonitorInput({ ...existing, ...ctx.body, config: ctx.body?.config ?? existing.config }, { existing });
    if (input.type !== row.type && ctx.body?.type) {   }
    validChannels(input.channelIds);
    monitors.update(row.id, input);
    scheduler.reschedule(row.id, 100);
    return decorate(monitors.row(row.id));
  });

  router.delete('/api/monitors/:id', auth.requireAuth, (ctx) => {
    const row = need(ctx.params.id);
    scheduler.cancel(row.id);
    monitors.remove(row.id);
    return { ok: true };
  });

  router.post('/api/monitors/:id/pause', auth.requireAuth, (ctx) => {
    const row = need(ctx.params.id);
    monitors.setEnabled(row.id, false);
    scheduler.cancel(row.id);
    return decorate(monitors.row(row.id));
  });

  router.post('/api/monitors/:id/resume', auth.requireAuth, (ctx) => {
    const row = need(ctx.params.id);
    monitors.setEnabled(row.id, true);
    scheduler.reschedule(row.id, 50);
    return decorate(monitors.row(row.id));
  });

  router.post('/api/monitors/:id/run', auth.requireAuth, async (ctx) => {
    const row = need(ctx.params.id);
    if (!row.enabled) throw new HttpError(409, 'Monitor is paused');
    const r = await scheduler.runNow(row.id);
    return { result: r?.result, monitor: decorate(monitors.row(row.id)) };
  });

   
  router.post('/api/monitors/test', auth.requireAuth, async (ctx) => {
    const { runCheck } = await import('../checks/index.js');
    const input = parseMonitorInput(ctx.body);
    if (input.type === 'push') throw new HttpError(422, 'Heartbeat monitors cannot be tested from here');
    const result = await runCheck({ type: input.type, timeout_ms: input.timeoutMs }, input.config);
    return { result };
  });

  router.get('/api/monitors/:id/checks', auth.requireAuth, (ctx) => {
    const row = need(ctx.params.id);
    const limit = Math.min(200, Math.max(1, Number(ctx.query.limit) || 50));
    return { checks: checks.recent(row.id, limit, ctx.query.before ? Number(ctx.query.before) : Infinity) };
  });

  router.get('/api/monitors/:id/stats', auth.requireAuth, (ctx) => {
    const row = need(ctx.params.id);
    const range = RANGE_KEYS.includes(ctx.query.range) ? ctx.query.range : '24h';
    return { ...stats.series(row.id, range), uptime: stats.uptimeSummary(row.id), daily: stats.dailyBars(row.id, 90) };
  });

  router.get('/api/monitors/:id/incidents', auth.requireAuth, (ctx) => {
    const row = need(ctx.params.id);
    return { incidents: incidents.list({ monitorId: row.id, limit: 50 }).rows.map(incidents.out) };
  });

   
  const push = (ctx) => {
    const m = monitors.byPushToken(ctx.params.token);
    if (!m || !m.enabled) throw notFound('Heartbeat');
    const status = String(ctx.query.status ?? ctx.body?.status ?? 'up').toLowerCase();
    const ok = status !== 'down' && status !== 'fail';
    const msg = String(ctx.query.msg ?? ctx.body?.msg ?? '').slice(0, 300) || null;
    const ping = Number(ctx.query.ping ?? ctx.body?.ping);
    const now = Date.now();
    monitors.markPush(m.id, now, ok, msg);
    pipeline.handleResult(m.id, { ok, latencyMs: Number.isFinite(ping) ? Math.round(ping) : null, error: ok ? null : msg || 'Job reported failure', meta: { via: 'push', msg } }, now);
    return { ok: true };
  };
  router.get('/api/push/:token', push);
  router.post('/api/push/:token', push);
}
