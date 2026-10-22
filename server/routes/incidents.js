import { validate } from '../validate.js';
import { HttpError, notFound } from '../util.js';

export function incidentRoutes({ router, models, auth, bus }) {
  const { incidents } = models;

  router.get('/api/incidents', auth.requireAuth, (ctx) => {
    const status = ['open', 'resolved'].includes(ctx.query.status) ? ctx.query.status : undefined;
    const limit = Math.min(100, Math.max(1, Number(ctx.query.limit) || 30));
    const offset = Math.max(0, Number(ctx.query.offset) || 0);
    const { total, rows } = incidents.list({ status, limit, offset, monitorId: ctx.query.monitorId ? Number(ctx.query.monitorId) : undefined });
    return { total, incidents: rows.map(incidents.out) };
  });

  router.get('/api/incidents/:id', auth.requireAuth, (ctx) => {
    const row = incidents.row(Number(ctx.params.id));
    if (!row) throw notFound('Incident');
    return { ...incidents.out(row), events: incidents.events(row.id) };
  });

  router.post('/api/incidents/:id/ack', auth.requireAuth, (ctx) => {
    const id = Number(ctx.params.id);
    const row = incidents.row(id);
    if (!row) throw notFound('Incident');
    if (row.resolved_at) throw new HttpError(409, 'Incident is already resolved');
    incidents.ack(id, ctx.user);
    bus.emit('incident', { id, monitorId: row.monitor_id, state: 'acknowledged' });
    return incidents.out(incidents.row(id));
  });

  router.post('/api/incidents/:id/comments', auth.requireAuth, (ctx) => {
    const id = Number(ctx.params.id);
    if (!incidents.row(id)) throw notFound('Incident');
    const b = validate({ message: { type: 'string', required: true, min: 1, max: 2000, trim: true } }, ctx.body);
    const eventId = incidents.addEvent(id, 'comment', ctx.user.name, b.message);
    ctx.status = 201;
    return { id: eventId, events: incidents.events(id) };
  });
}
