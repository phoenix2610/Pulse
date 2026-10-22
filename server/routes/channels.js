import { validate } from '../validate.js';
import { HttpError, notFound, parseJson } from '../util.js';
import { MASK } from '../models.js';
import { CHANNEL_TYPES, channelSchemas, buildEvent, deliver } from '../notifiers/index.js';

 
function mergeMasked(next, prev) {
  const out = { ...next };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.includes('••')) out[k] = prev?.[k] ?? '';
  }
  return out;
}

export function channelRoutes({ router, models, auth, config, fetchImpl }) {
  const { channels, monitors } = models;

  const envelope = {
    name: { type: 'string', required: true, min: 1, max: 80 },
    type: { type: 'string', required: true, enum: CHANNEL_TYPES },
    config: { type: 'object' },
    enabled: { type: 'bool', default: true },
    applyAll: { type: 'bool', default: false },
    monitorIds: { type: 'array', max: 1000, items: { type: 'int', min: 1 } },
  };

  const parse = (body, prev, partial = false) => {
    const input = validate(envelope, body, { partial });
    const type = input.type ?? prev?.type;
    if (type) {
      const cfg = mergeMasked(body?.config ?? {}, parseJson(prev?.config, {}));
      input.config = validate(channelSchemas[type], cfg, { path: 'config' });
    }
    for (const id of input.monitorIds ?? []) if (!monitors.row(id)) throw new HttpError(422, 'Validation failed', { monitorIds: `monitor ${id} does not exist` });
    return input;
  };

  router.get('/api/channels', auth.requireAuth, () => ({ channels: channels.listRows().map((r) => channels.out(r)), types: CHANNEL_TYPES }));
  router.get('/api/channels/log', auth.requireAuth, (ctx) => ({ log: channels.recentLog(Math.min(200, Number(ctx.query.limit) || 50)) }));

  router.post('/api/channels', auth.requireAuth, (ctx) => {
    const input = parse(ctx.body);
    const id = channels.create(input);
    if (input.monitorIds) channels.setMonitors(id, input.monitorIds);
    ctx.status = 201;
    return channels.out(channels.row(id));
  });

  router.put('/api/channels/:id', auth.requireAuth, (ctx) => {
    const id = Number(ctx.params.id);
    const prev = channels.row(id);
    if (!prev) throw notFound('Channel');
    const input = parse({ ...channels.out(prev, { redact: false }), ...ctx.body }, prev);
    channels.update(id, input);
    if (input.monitorIds) channels.setMonitors(id, input.monitorIds);
    return channels.out(channels.row(id));
  });

  router.delete('/api/channels/:id', auth.requireAuth, (ctx) => {
    if (!channels.remove(Number(ctx.params.id))) throw notFound('Channel');
    return { ok: true };
  });

  router.post('/api/channels/:id/test', auth.requireAuth, async (ctx) => {
    const ch = channels.row(Number(ctx.params.id));
    if (!ch) throw notFound('Channel');
    const ev = buildEvent('test', { baseUrl: config.baseUrl });
    const r = await deliver(ch, ev, { attempts: 1, fetchImpl });
    channels.log(ch.id, null, 'test', r.ok, r.error);
    return r;
  });
}
export { MASK };
