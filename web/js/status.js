import { h, mount, icon } from './lib/dom.js';
import { uptimeStrip } from './lib/charts.js';
import { pct, dateTime, duration, ago, STATUS_LABEL } from './lib/format.js';

const slug = location.pathname.split('/').filter(Boolean)[1];
const app = document.getElementById('app');
try { const t = localStorage.getItem('pulse-theme'); document.documentElement.dataset.theme = t || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); } catch {   }

const OVERALL = {
  operational: 'All systems operational', degraded: 'Some systems are degraded', partial_outage: 'Partial outage',
  outage: 'Major outage', maintenance: 'Scheduled maintenance in progress',
};

async function load() {
  const res = await fetch(`/api/public/status/${encodeURIComponent(slug ?? '')}`);
  if (res.status === 404) return mount(app, h('div.wrap', h('div.overall.outage', 'Status page not found')));
  const d = await res.json();
  document.title = `${d.title} — Status`;
  mount(app, h('div.wrap',
    h('div.pub-head', h('h1', d.title), d.description ? h('p', d.description) : null),
    d.announcements.map((a) => h('div', { class: 'announce ' + a.level }, h('b', a.title), a.body ? h('span', a.body) : null)),
    d.maintenance.length ? d.maintenance.map((m) => h('div.announce', h('b', `${m.state === 'active' ? 'Maintenance in progress' : 'Scheduled maintenance'}: ${m.name}`), h('span', `${dateTime(m.startsAt)} → ${dateTime(m.endsAt)}`))) : null,
    h('div', { class: 'overall ' + d.overall }, h('span', { class: 'dot ' + (d.overall === 'operational' ? 'operational' : d.overall === 'maintenance' ? 'maintenance' : d.overall === 'degraded' ? 'degraded' : 'outage'), style: { width: '14px', height: '14px' } }), OVERALL[d.overall] ?? d.overall),
    h('div.card', d.monitors.map((m) => h('div.svc',
      h('div.head', h('span', { class: 'dot ' + m.status }), h('span.name', m.name), h('span.muted', pct(m.uptime90, 2) + ' uptime'), h('span', { class: 'badge ' + m.status }, STATUS_LABEL[m.status] ?? m.status)),
      uptimeStrip(m.bars)))),
    h('h2', { style: { margin: '32px 0 12px' } }, 'Past incidents (14 days)'),
    d.incidents.length ? h('div.card', d.incidents.map((i) => h('div.svc', h('div.row', h('b.grow', i.monitor), h('span', { class: 'badge ' + (i.resolvedAt ? 'resolved' : 'open') }, h('i'), i.resolvedAt ? 'Resolved' : 'Ongoing')),
      h('div.muted', { style: { fontSize: '13px', marginTop: '4px' } }, `${dateTime(i.startedAt)} · ${duration(i.durationMs)}`)))) : h('div.card.pad.muted', 'No incidents in the last 14 days.'),
    h('div.pub-foot', `Updated ${ago(d.updatedAt)} · Powered by Pulse`)));
}
load().catch((e) => mount(app, h('div.wrap', h('div.overall.outage', `Unable to load status: ${e.message}`))));
setInterval(() => load().catch(() => {}), 30_000);
