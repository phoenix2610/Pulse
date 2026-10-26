import { h, mount, icon } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { api } from '../lib/api.js';
import { link } from '../lib/router.js';
import { sparkline } from '../lib/charts.js';
import { ago, duration, pct, ms, target, TYPE_LABEL } from '../lib/format.js';
import { empty, statusBadge, toast, debounce, raf } from '../lib/ui.js';

function monitorCard(m0) {
  let m = m0;
  const dot = h('span.dot');
  const name = h('div.name.truncate');
  const tgt = h('div.target.truncate');
  const badge = h('span');
  const spark = h('div');
  const meta = h('div.meta');
  const err = h('div.err.truncate', { style: { fontWeight: 400 } });
  const el = h('a.card.clickable.mcard', { href: link(`/monitors/${m.id}`), style: { color: 'inherit', textDecoration: 'none' } },
    h('div.top', dot, h('div.grow', name, tgt), badge), spark, meta, err);

  function update(next) {
    m = next;
    el.classList.toggle('is-down', m.status === 'down');
    dot.className = `dot ${m.status}`;
    name.textContent = m.name;
    tgt.textContent = target(m);
    badge.replaceChildren(statusBadge(m.maintenance && m.status !== 'paused' ? 'maintenance' : m.status));
    spark.replaceChildren(sparkline(m.sparkline ?? []));
    meta.replaceChildren(...[
      h('span', 'Uptime ', h('b', pct(m.uptime24h, 2))),
      m.type !== 'push' ? h('span', 'Latency ', h('b', m.status === 'up' ? ms(m.lastLatencyMs) : '—')) : null,
      h('span.grow.right.faint', m.status === 'paused' ? 'paused' : ago(m.lastCheckedAt))].filter(Boolean));
    err.textContent = m.status === 'down' || m.status === 'pending' ? (m.lastError ?? '') : '';
    err.classList.toggle('hidden', !err.textContent);
  }
  update(m0);
  return { el, update, get id() { return m.id; } };
}

export async function dashboardView(root) {
  const filters = { q: '', status: 'all' };
  const cards = new Map();
  const tilesEl = h('div.grid.cols-4');
  const listEl = h('div');
  const bannerEl = h('div');

  const search = h('input', { type: 'search', placeholder: 'Search monitors…', oninput: debounce((e) => { filters.q = e.target.value.toLowerCase(); renderList(); }, 120) });
  const seg = h('div.seg', [['all', 'All'], ['down', 'Down'], ['up', 'Up'], ['paused', 'Paused']].map(([v, label]) =>
    h('button', { class: v === 'all' ? 'on' : '', 'data-v': v, onclick: (e) => { filters.status = v; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); renderList(); } }, label)));

  mount(root,
    h('div.page-head', h('div.grow', h('h1', 'Monitors'), h('div.sub#sub', ' ')),
      h('div.search', icon('search', 15), search), seg,
      h('a.btn.primary', { href: link('/monitors/new') }, icon('plus', 15), 'New monitor')),
    bannerEl, tilesEl, listEl);

  function renderTiles() {
    const s = store.summary;
    if (!s) return;
    const allUp = s.counts.down === 0 && s.total > 0;
    tilesEl.replaceChildren(
      tile('Status', allUp ? 'All systems up' : s.total ? `${s.counts.down} down` : '—', `${s.counts.up ?? 0} up · ${s.counts.paused ?? 0} paused`, allUp ? 'var(--green)' : s.counts.down ? 'var(--red)' : undefined),
      tile('Uptime (24h)', s.avgUptime24h == null ? '—' : s.avgUptime24h.toFixed(2), 'average across monitors', undefined, s.avgUptime24h == null ? '' : '%'),
      tile('Avg latency', s.avgLatencyMs == null ? '—' : s.avgLatencyMs, 'monitors currently up', undefined, s.avgLatencyMs == null ? '' : 'ms'),
      tile('Incidents', s.openIncidents.length, `${s.incidents7d} in the last 7 days`, s.openIncidents.length ? 'var(--red)' : undefined));
    const open = s.openIncidents;
    bannerEl.replaceChildren(...(open.length ? [h('div.banner.red', { style: { marginBottom: '14px', display: 'flex', gap: '10px', alignItems: 'center' } }, icon('alert', 16),
      h('span.grow', `${open.length} open incident${open.length > 1 ? 's' : ''}: `, open.slice(0, 3).map((i, n) => [n ? ', ' : '', h('a', { href: link(`/incidents/${i.id}`), style: { color: 'inherit', textDecoration: 'underline' } }, i.monitorName)])))] : []));
  }
  const tile = (label, value, foot, color, unit) => h('div.card.stat', h('div.label', label),
    h('div.value', { style: color ? { color } : {} }, String(value), unit ? h('small', unit) : null), h('div.foot', foot));

  const matches = (m) => (filters.status === 'all' || m.status === filters.status)
    && (!filters.q || m.name.toLowerCase().includes(filters.q) || target(m).toLowerCase().includes(filters.q) || m.tags.some((t) => t.includes(filters.q)));

  function renderList() {
    const list = [...store.monitors.values()].filter(matches);
    document.getElementById('sub').textContent = `${store.monitors.size} monitor${store.monitors.size === 1 ? '' : 's'}`;
    if (!store.monitors.size) {
      return mount(listEl, h('div.card', empty('activity', 'No monitors yet', 'Add a website, API, port, DNS record, certificate or cron heartbeat to start tracking uptime.',
        h('a.btn.primary', { href: link('/monitors/new') }, icon('plus', 15), 'Create your first monitor'))));
    }
    if (!list.length) return mount(listEl, h('div.card', empty('search', 'No matches', 'Try a different search or filter.')));
    const groups = new Map();
    for (const m of list) { const g = m.group || ''; (groups.get(g) ?? groups.set(g, []).get(g)).push(m); }
    const ordered = [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
     
    const rank = { down: 0, pending: 1, maintenance: 2, up: 3, paused: 4 };
    const seen = new Set();
    listEl.replaceChildren(...ordered.map(([g, ms_]) => {
      ms_.sort((a, b) => (rank[a.status] - rank[b.status]) || a.name.localeCompare(b.name));
      const grid = h('div.grid.auto', ms_.map((m) => {
        seen.add(m.id);
        let c = cards.get(m.id);
        if (!c) { c = monitorCard(m); cards.set(m.id, c); } else c.update(m);
        return c.el;
      }));
      return h('div', ordered.length > 1 || g ? h('div.group-title', g || 'Ungrouped') : null, grid);
    }));
    for (const id of [...cards.keys()]) if (!store.monitors.has(id)) cards.delete(id);
  }

  await Promise.all([store.loadMonitors(), store.loadSummary()]).catch((e) => toast(e.message, 'err'));
  renderTiles(); renderList();

   
  const offs = [
    store.on('check', (c) => {
      const m = store.monitors.get(c.monitorId);
      const card = cards.get(c.monitorId);
      if (m && card) raf(() => card.update(m));
      if (m && !matches(m)) raf(renderList);
    }),
    store.on('summary', () => raf(renderTiles)),
    store.on('status', () => raf(renderList)),
  ];
  const tick = setInterval(() => cards.forEach((c) => { const m = store.monitors.get(c.id); if (m) c.update(m); }), 15000);  
  return () => { offs.forEach((f) => f()); clearInterval(tick); };
}
