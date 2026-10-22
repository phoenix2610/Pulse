import { validate } from '../validate.js';
import { HttpError, notFound, DAY, HOUR } from '../util.js';
import { openSse, sendJson } from '../http.js';

export function maintenanceRoutes({ router, models, auth }) {
  const { maintenance, monitors } = models;
  const schema = {
    name: { type: 'string', required: true, min: 1, max: 120 },
    startsAt: { type: 'int', required: true, min: 0 },
    endsAt: { type: 'int', required: true, min: 0 },
    monitorIds: { type: 'array', max: 1000, items: { type: 'int', min: 1 }, default: () => [] },
  };
  const parse = (body, partial) => {
    const b = validate(schema, body, { partial });
    if (b.startsAt !== undefined && b.endsAt !== undefined && b.endsAt <= b.startsAt) throw new HttpError(422, 'Validation failed', { endsAt: 'must be after startsAt' });
    for (const id of b.monitorIds ?? []) if (!monitors.row(id)) throw new HttpError(422, 'Validation failed', { monitorIds: `monitor ${id} does not exist` });
    return b;
  };
  router.get('/api/maintenance', auth.requireAuth, () => ({ maintenance: maintenance.list() }));
  router.post('/api/maintenance', auth.requireAuth, (ctx) => {
    const id = maintenance.create(parse(ctx.body));
    ctx.status = 201;
    return maintenance.list().find((m) => m.id === id);
  });
  router.put('/api/maintenance/:id', auth.requireAuth, (ctx) => {
    const id = Number(ctx.params.id);
    const cur = maintenance.list().find((m) => m.id === id);
    if (!cur) throw notFound('Maintenance window');
    maintenance.update(id, parse({ ...cur, ...ctx.body }));
    return maintenance.list().find((m) => m.id === id);
  });
  router.delete('/api/maintenance/:id', auth.requireAuth, (ctx) => {
    if (!maintenance.remove(Number(ctx.params.id))) throw notFound('Maintenance window');
    return { ok: true };
  });
}

const SLUG = { type: 'string', required: true, min: 2, max: 60, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: 'lowercase letters, digits and dashes' };
const RESERVED = new Set(['api', 'admin', 'status', 'badge', 'static', 'css', 'js', 'assets']);

export function statusPageRoutes({ router, models, auth, stats }) {
  const { pages, monitors, incidents } = models;
  const schema = {
    slug: SLUG,
    title: { type: 'string', required: true, min: 1, max: 120 },
    description: { type: 'string', max: 1000, nullable: true },
    monitors: { type: 'array', max: 200, default: () => [], items: { type: 'object', props: { monitorId: { type: 'int', required: true, min: 1 }, label: { type: 'string', max: 100, nullable: true } } } },
  };
  const parse = (body, partial) => {
    const b = validate(schema, body, { partial });
    if (b.slug && RESERVED.has(b.slug)) throw new HttpError(422, 'Validation failed', { slug: 'is reserved' });
    for (const m of b.monitors ?? []) if (!monitors.row(m.monitorId)) throw new HttpError(422, 'Validation failed', { monitors: `monitor ${m.monitorId} does not exist` });
    return b;
  };
  const uniqueSlug = (slug, exceptId) => {
    const ex = pages.bySlug(slug);
    if (ex && ex.id !== exceptId) throw new HttpError(409, 'Slug already in use', { slug: 'is already in use' });
  };

  router.get('/api/status-pages', auth.requireAuth, () => ({ pages: pages.list() }));
  router.post('/api/status-pages', auth.requireAuth, (ctx) => {
    const b = parse(ctx.body);
    uniqueSlug(b.slug);
    const id = pages.create(b);
    ctx.status = 201;
    return pages.out(pages.byId(id));
  });
  router.put('/api/status-pages/:id', auth.requireAuth, (ctx) => {
    const id = Number(ctx.params.id);
    const cur = pages.byId(id);
    if (!cur) throw notFound('Status page');
    const b = parse({ ...pages.out(cur), ...ctx.body });
    uniqueSlug(b.slug, id);
    pages.update(id, b);
    return pages.out(pages.byId(id));
  });
  router.delete('/api/status-pages/:id', auth.requireAuth, (ctx) => {
    if (!pages.remove(Number(ctx.params.id))) throw notFound('Status page');
    return { ok: true };
  });
  router.post('/api/status-pages/:id/announcements', auth.requireAuth, (ctx) => {
    const id = Number(ctx.params.id);
    if (!pages.byId(id)) throw notFound('Status page');
    const b = validate({
      title: { type: 'string', required: true, min: 1, max: 160 }, body: { type: 'string', max: 4000, nullable: true },
      level: { type: 'string', enum: ['info', 'warning', 'critical'], default: 'info' }, expiresAt: { type: 'int', nullable: true },
    }, ctx.body);
    pages.addAnnouncement(id, b);
    ctx.status = 201;
    return { announcements: pages.announcements(id, true) };
  });
  router.delete('/api/status-pages/:id/announcements/:aid', auth.requireAuth, (ctx) => {
    if (!pages.removeAnnouncement(Number(ctx.params.id), Number(ctx.params.aid))) throw notFound('Announcement');
    return { ok: true };
  });

   
  router.get('/api/public/status/:slug', (ctx) => {
    const page = pages.bySlug(ctx.params.slug);
    if (!page) throw notFound('Status page');
    const now = Date.now();
    const items = pages.monitors(page.id).map((pm) => {
      const row = monitors.row(pm.monitor_id);
      const inMaint = !!models.maintenance.activeFor(row.id, now);
      return {
        id: row.id, name: pm.label || row.name, status: publicStatus(row.status, inMaint), uptime90: stats.uptime(row.id, 90 * DAY),
        uptime24h: stats.uptime(row.id, DAY), bars: stats.dailyBars(row.id, 90), latencyMs: row.last_latency_ms,
      };
    });
    const ids = items.map((i) => i.id);
    const recent = ids.flatMap((id) => incidents.list({ monitorId: id, since: now - 14 * DAY, limit: 20 }).rows)
      .sort((a, b) => b.started_at - a.started_at).slice(0, 15)
      .map((r) => ({ id: r.id, monitor: items.find((i) => i.id === r.monitor_id)?.name, startedAt: r.started_at, resolvedAt: r.resolved_at, cause: null, durationMs: (r.resolved_at ?? now) - r.started_at }));
    const upcoming = models.maintenance.list().filter((m) => m.state !== 'past' && (m.monitorIds.length === 0 || m.monitorIds.some((id) => ids.includes(id))))
      .map((m) => ({ name: m.name, startsAt: m.startsAt, endsAt: m.endsAt, state: m.state }));
    return {
      title: page.title, description: page.description, updatedAt: now, overall: overall(items),
      monitors: items, incidents: recent, maintenance: upcoming, announcements: pages.announcements(page.id),
    };
  });

  router.get('/badge/:id/status.svg', (ctx) => {
    const id = Number(ctx.params.id);
    const row = monitors.row(id);
    if (!row || !pages.isPublic(id)) throw notFound('Badge');
    const inMaint = !!models.maintenance.activeFor(id);
    const st = publicStatus(row.status, inMaint);
    const [text, color] = { operational: ['up', '#30a46c'], degraded: ['degraded', '#f5a524'], outage: ['down', '#e5484d'], maintenance: ['maintenance', '#3e63dd'] }[st];
    const label = (ctx.query.label || row.name).slice(0, 40);
    ctx.raw(200, badge(label, text, color), { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=60' });
  });
  router.get('/badge/:id/uptime.svg', (ctx) => {
    const id = Number(ctx.params.id);
    const row = monitors.row(id);
    if (!row || !pages.isPublic(id)) throw notFound('Badge');
    const days = [1, 7, 30, 90].includes(Number(ctx.query.days)) ? Number(ctx.query.days) : 30;
    const u = stats.uptime(id, days * DAY);
    const color = u == null ? '#8b8d98' : u >= 99.9 ? '#30a46c' : u >= 99 ? '#a3c644' : u >= 95 ? '#f5a524' : '#e5484d';
    ctx.raw(200, badge(`uptime ${days}d`, u == null ? 'n/a' : `${u}%`, color), { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=300' });
  });
}

export const publicStatus = (status, inMaintenance) =>
  inMaintenance || status === 'maintenance' ? 'maintenance' : status === 'down' ? 'outage' : status === 'pending' ? 'degraded' : 'operational';

export function overall(items) {
  if (!items.length) return 'operational';
  const outages = items.filter((i) => i.status === 'outage').length;
  if (outages === items.length) return 'outage';
  if (outages) return 'partial_outage';
  if (items.some((i) => i.status === 'degraded')) return 'degraded';
  if (items.some((i) => i.status === 'maintenance')) return 'maintenance';
  return 'operational';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function badge(label, value, color) {
  const w = (s) => Math.round(s.length * 6.4 + 12);
  const lw = w(label), vw = w(value), total = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${total}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

export function systemRoutes({ router, models, auth, bus, stats, scheduler, config, exporter }) {
  const { monitors, incidents, settings } = models;

  router.get('/healthz', () => ({ ok: true, uptimeS: Math.round(process.uptime()) }));

  router.get('/api/summary', auth.requireAuth, () => {
    const rows = monitors.listRows();
    const counts = { up: 0, down: 0, pending: 0, paused: 0, maintenance: 0 };
    let sumUptime = 0, n = 0, latSum = 0, latN = 0;
    for (const r of rows) {
      counts[r.status] = (counts[r.status] ?? 0) + 1;
      if (r.enabled) {
        const u = stats.uptime(r.id, DAY);
        if (u != null) { sumUptime += u; n++; }
        if (r.status === 'up' && r.last_latency_ms != null) { latSum += r.last_latency_ms; latN++; }
      }
    }
    const open = incidents.list({ status: 'open', limit: 10 }).rows.map(incidents.out);
    return {
      total: rows.length, counts, avgUptime24h: n ? Math.round((sumUptime / n) * 100) / 100 : null,
      avgLatencyMs: latN ? Math.round(latSum / latN) : null, openIncidents: open,
      incidents7d: incidents.list({ since: Date.now() - 7 * DAY, limit: 1 }).total,
      scheduler: scheduler.stats, serverTime: Date.now(),
    };
  });

  router.get('/api/settings', auth.requireAuth, () => ({ baseUrl: settings.get('baseUrl', config.baseUrl), certWarnDays: settings.get('certWarnDays', 14), retention: { rawDays: config.rawRetentionDays, rollupDays: config.rollupRetentionDays } }));
  router.put('/api/settings', auth.requireAuth, (ctx) => {
    const b = validate({ baseUrl: { type: 'string', max: 300, pattern: /^(https?:\/\/[^\s]+)?$/, message: 'must be an http(s) URL' }, certWarnDays: { type: 'int', min: 1, max: 90 } }, ctx.body, { partial: true });
    if (b.baseUrl !== undefined) settings.set('baseUrl', b.baseUrl.replace(/\/$/, ''));
    if (b.certWarnDays !== undefined) settings.set('certWarnDays', b.certWarnDays);
    return { ok: true };
  });

  router.get('/api/events', auth.requireAuth, (ctx) => {
    const sse = openSse(ctx.req, ctx.res);
    ctx.handled = true;
    sse.send('hello', { serverTime: Date.now() });
    const unsub = bus.subscribe((e) => sse.send(e.type, { ...e.data, ts: e.ts }));
    ctx.req.on('close', unsub);
  });

  router.get('/api/export', auth.requireAuth, (ctx) => {
    ctx.res.setHeader('content-disposition', 'attachment; filename="pulse-export.json"');
    return exporter.export();
  });
  router.post('/api/import', auth.requireAuth, (ctx) => ({ imported: exporter.import(ctx.body) }));
}
