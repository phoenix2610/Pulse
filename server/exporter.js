import { validate } from './validate.js';
import { HttpError, parseJson } from './util.js';
import { parseMonitorInput } from './routes/monitors.js';
import { channelSchemas, CHANNEL_TYPES } from './notifiers/index.js';
import { tx } from './db.js';

 
export function createExporter({ models, scheduler }) {
  const { monitors, channels, pages, db } = models;

  return {
    export() {
      const chRows = channels.listRows();
      return {
        version: 1, exportedAt: new Date().toISOString(),
        channels: chRows.map((c) => ({ ref: c.id, name: c.name, type: c.type, enabled: !!c.enabled, applyAll: !!c.apply_all, config: parseJson(c.config, {}) })),
        monitors: monitors.listRows().map((r) => {
          const m = monitors.out(r);
          return { name: m.name, type: m.type, config: m.config, intervalS: m.intervalS, timeoutMs: m.timeoutMs, retries: m.retries, enabled: m.enabled, group: m.group, tags: m.tags, channelRefs: monitors.channelIds(r.id) };
        }),
        statusPages: pages.list().map((p) => ({ slug: p.slug, title: p.title, description: p.description, monitors: p.monitors.map((m) => monitors.row(m.monitorId)?.name).filter(Boolean) })),
      };
    },

    import(data) {
      if (!data || data.version !== 1 || !Array.isArray(data.monitors)) throw new HttpError(422, 'Not a Pulse export (expected version 1)');
      const created = { channels: 0, monitors: 0, statusPages: 0 };
      const refMap = new Map();
      const nameToId = new Map(monitors.listRows().map((r) => [r.name, r.id]));
      const newIds = [];
      tx(db, () => {
        for (const c of data.channels ?? []) {
          if (!CHANNEL_TYPES.includes(c.type)) throw new HttpError(422, `Unknown channel type "${c.type}"`);
          const cfg = validate(channelSchemas[c.type], c.config ?? {}, { path: `channels[${c.name}].config` });
          refMap.set(c.ref, channels.create({ name: String(c.name).slice(0, 80), type: c.type, config: cfg, enabled: c.enabled !== false, applyAll: !!c.applyAll }));
          created.channels++;
        }
        for (const raw of data.monitors) {
          const input = parseMonitorInput(raw);
          input.channelIds = (raw.channelRefs ?? []).map((r) => refMap.get(r)).filter(Boolean);
          const id = monitors.create(input);
          nameToId.set(input.name, id);
          newIds.push([id, input.enabled]);
          created.monitors++;
        }
        for (const p of data.statusPages ?? []) {
          if (pages.bySlug(p.slug)) continue;
          pages.create({ slug: p.slug, title: p.title, description: p.description, monitors: (p.monitors ?? []).map((n) => nameToId.get(n)).filter(Boolean).map((monitorId) => ({ monitorId })) });
          created.statusPages++;
        }
      });
      for (const [id, enabled] of newIds) if (enabled) scheduler.reschedule(id, 200);
      return created;
    },
  };
}
