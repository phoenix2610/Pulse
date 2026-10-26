import { h, mount, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { link, go } from '../lib/router.js';
import { ago, duration, dateTime, fullDate } from '../lib/format.js';
import { empty, statusBadge, toast, raf } from '../lib/ui.js';

export async function incidentsView(root, _p, query) {
  let status = query.status ?? 'all', offset = 0;
  const limit = 25;
  const body = h('div.card');
  const seg = h('div.seg', [['all', 'All'], ['open', 'Open'], ['resolved', 'Resolved']].map(([v, l]) =>
    h('button', { class: v === status ? 'on' : '', onclick: () => { status = v; offset = 0; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.textContent === l)); load(); } }, l)));
  mount(root, h('div.page-head', h('div.grow', h('h1', 'Incidents'), h('div.sub', 'Every outage, from detection to recovery.')), seg), body);

  async function load() {
    const q = new URLSearchParams({ limit, offset }); if (status !== 'all') q.set('status', status);
    const { incidents, total } = await api.get(`/api/incidents?${q}`);
    if (!incidents.length && !offset) return mount(body, empty('shield', status === 'open' ? 'No open incidents' : 'No incidents recorded', 'Incidents open automatically when a monitor goes down and close when it recovers.'));
    mount(body, h('div.scroll-x', h('table.tbl', h('thead', h('tr', ['Status', 'Monitor', 'Started', 'Duration', 'Cause', ''].map((t) => h('th', t)))),
      h('tbody', incidents.map((i) => h('tr.link', { onclick: () => go(`/incidents/${i.id}`) },
        h('td', statusBadge(i.open ? 'open' : 'resolved'), i.ackAt && i.open ? h('span.tag', { style: { marginLeft: '6px' } }, 'ack') : null),
        h('td', { style: { fontWeight: 600 } }, i.monitorName), h('td.nowrap', dateTime(i.startedAt)), h('td.nowrap', duration(i.durationMs)),
        h('td.muted.truncate', { style: { maxWidth: '380px' } }, i.cause ?? ''), h('td', icon('chevron', 14))))))),
      total > limit ? h('div.row', { style: { padding: '12px 16px', borderTop: '1px solid var(--border)' } },
        h('span.muted.grow', `${offset + 1}–${Math.min(total, offset + limit)} of ${total}`),
        h('button.btn.sm', { disabled: offset === 0, onclick: () => { offset -= limit; load(); } }, 'Previous'), h('button.btn.sm', { disabled: offset + limit >= total, onclick: () => { offset += limit; load(); } }, 'Next')) : null);
  }
  await load();
  return store.on('incident', () => raf(() => load().catch(() => {})));
}

export async function incidentView(root, { id }) {
  let inc;
  const head = h('div'), timeline = h('div.card'), side = h('div.stack');
  async function load() {
    try { inc = await api.get(`/api/incidents/${id}`); } catch (e) { return mount(root, h('div.card', empty('alert', 'Incident not found', e.message))); }
    render();
  }
  function render() {
    mount(head, h('div.page-head', h('a.btn.ghost.icon', { href: link('/incidents') }, icon('chevron', 16, { style: 'transform:rotate(180deg)' })),
      h('div.grow', h('div.row', h('h1', `Incident #${inc.id}`), statusBadge(inc.open ? 'open' : 'resolved')), h('div.sub', h('a', { href: link(`/monitors/${inc.monitorId}`) }, inc.monitorName), ` · started ${fullDate(inc.startedAt)}`)),
      inc.open && !inc.ackAt ? h('button.btn.primary', { onclick: async () => { try { await api.post(`/api/incidents/${id}/ack`); toast('Acknowledged', 'ok'); load(); } catch (e) { toast(e.message, 'err'); } } }, icon('check', 15), 'Acknowledge') : null));
    const comment = h('textarea', { placeholder: 'Add a note for your team…', rows: 3, style: { fontFamily: 'var(--sans)' } });
    mount(timeline, h('header', h('h2', 'Timeline')), h('div.body',
      h('div.timeline', inc.events.map((e) => h('div', { class: 'tl-item ' + e.kind },
        h('div', h('span.who', { opened: 'Incident opened', resolved: 'Resolved', ack: `Acknowledged by ${e.author}`, comment: e.author ?? 'Note', notified: 'Notification' }[e.kind] ?? e.kind), h('span.when', ` · ${dateTime(e.ts)}`)),
        e.message ? h('div.msg' + (e.kind === 'comment' ? '' : '.muted'), e.message) : null))),
      h('form.stack', { style: { marginTop: '8px' }, onsubmit: async (ev) => { ev.preventDefault(); if (!comment.value.trim()) return; try { await api.post(`/api/incidents/${id}/comments`, { message: comment.value }); comment.value = ''; load(); } catch (e) { toast(e.message, 'err'); } } },
        comment, h('div', h('button.btn', { type: 'submit' }, 'Add note')))));
    mount(side,
      h('div.card', h('header', h('h2', 'Summary')), h('table.tbl', h('tbody',
        row('Duration', duration(inc.durationMs) + (inc.open ? ' (ongoing)' : '')), row('Started', fullDate(inc.startedAt)), row('Resolved', inc.resolvedAt ? fullDate(inc.resolvedAt) : '—'),
        row('Acknowledged', inc.ackAt ? `${inc.ackBy} · ${ago(inc.ackAt)}` : 'No'), row('Cause', inc.cause ?? '—')))));
  }
  const row = (k, v) => h('tr', h('td.muted', { style: { width: '120px' } }, k), h('td', v));
  mount(root, head, h('div.grid.cols-2', { style: { gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' } }, timeline, side));
  await load();
  const off = store.on('incident', (e) => { if (e.id === Number(id)) load(); });
  const tick = setInterval(() => inc?.open && render(), 30000);
  return () => { off(); clearInterval(tick); };
}
