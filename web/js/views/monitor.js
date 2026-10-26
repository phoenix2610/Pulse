import { h, mount, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { link, go } from '../lib/router.js';
import { latencyChart, uptimeStrip } from '../lib/charts.js';
import { ago, duration, pct, ms, target, dateTime, fullDate, TYPE_LABEL } from '../lib/format.js';
import { empty, statusBadge, toast, confirmDialog, copyBox, raf } from '../lib/ui.js';

const RANGES = ['1h', '24h', '7d', '30d', '90d'];

export async function monitorView(root, { id }) {
  let m;
  try { m = await api.get(`/api/monitors/${id}`); } catch (e) {
    return mount(root, h('div.card', empty('alert', 'Monitor not found', e.message, h('a.btn', { href: link('/') }, 'Back to monitors'))));
  }
  let range = '24h';
  const headEl = h('div');
  const statsEl = h('div.grid.cols-4');
  const chartCard = h('div.card');
  const stripEl = h('div.card.pad');
  const checksEl = h('div.card');
  const incidentsEl = h('div.card');
  const detailEl = h('div.card');
  let stopped = false;

  const act = (fn, msg) => async () => {
    try { const r = await fn(); if (msg) toast(msg, 'ok'); await reload(); return r; } catch (e) { toast(e.message, 'err'); }
  };

  function renderHead() {
    const paused = !m.enabled;
    mount(headEl,
      h('div.page-head',
        h('a.btn.ghost.icon', { href: link('/'), title: 'Back' }, icon('chevron', 16, { style: 'transform:rotate(180deg)' })),
        h('div.grow', h('div.row', h('h1', m.name), statusBadge(m.maintenance && !paused ? 'maintenance' : m.status), m.group ? h('span.tag', m.group) : null, m.tags.map((t) => h('span.tag', t))),
          h('div.sub.mono.truncate', `${TYPE_LABEL[m.type]} · ${target(m)}`)),
        m.enabled && m.type !== 'push' ? h('button.btn', { onclick: async (e) => { e.currentTarget.disabled = true; await act(() => api.post(`/api/monitors/${id}/run`), 'Check completed')(); } }, icon('refresh', 15), 'Check now') : null,
        paused ? h('button.btn', { onclick: act(() => api.post(`/api/monitors/${id}/resume`), 'Monitor resumed') }, icon('play', 15), 'Resume')
          : h('button.btn', { onclick: act(() => api.post(`/api/monitors/${id}/pause`), 'Monitor paused') }, icon('pause', 15), 'Pause'),
        h('a.btn', { href: link(`/monitors/${id}/edit`) }, icon('edit', 15), 'Edit'),
        h('button.btn.danger', { onclick: async () => { if (await confirmDialog({ title: 'Delete monitor', message: `Delete “${m.name}” and all its history? This cannot be undone.`, confirmLabel: 'Delete', danger: true })) { await api.del(`/api/monitors/${id}`); toast('Monitor deleted', 'ok'); go('/'); } } }, icon('trash', 15))),
      m.status === 'down' && m.lastError ? h('div.banner.red', { style: { marginBottom: '16px' } }, h('b', 'Failing: '), m.lastError, m.openIncidentId ? h('a', { href: link(`/incidents/${m.openIncidentId}`), style: { marginLeft: '10px', color: 'inherit', textDecoration: 'underline' } }, 'View incident →') : null) : null);
  }

  function renderStats() {
    const u = m.uptime ?? {}, cur = m.status;
    const stat = (label, value, foot, unit) => h('div.card.stat', h('div.label', label), h('div.value', value, unit ? h('small', unit) : null), h('div.foot', foot));
    mount(statsEl,
      stat('Current', m.status === 'up' ? 'Up' : m.status === 'down' ? 'Down' : m.status[0].toUpperCase() + m.status.slice(1), m.lastStatusChangeAt ? `for ${duration(Date.now() - m.lastStatusChangeAt)}` : 'no data yet'),
      stat('Uptime 24h', u['24h'] == null ? '—' : u['24h'].toFixed(2), `7d ${pct(u['7d'])} · 30d ${pct(u['30d'])}`, u['24h'] == null ? '' : '%'),
      stat('Response', m.type === 'push' ? '—' : m.lastLatencyMs ?? '—', m.lastCheckedAt ? `checked ${ago(m.lastCheckedAt)}` : 'not checked yet', m.lastLatencyMs == null || m.type === 'push' ? '' : 'ms'),
      stat('Incidents (30d)', m.incidentStats?.count ?? 0, m.incidentStats?.mttrMs ? `MTTR ${duration(m.incidentStats.mttrMs)} · down ${duration(m.incidentStats.downtimeMs)}` : 'none'));
  }

  async function renderChart() {
    let data;
    try { data = await api.get(`/api/monitors/${id}/stats?range=${range}`); } catch (e) { return toast(e.message, 'err'); }
    if (stopped) return;
    const p = data.percentiles;
    mount(chartCard,
      h('header', h('h2', m.type === 'push' ? 'Heartbeat history' : 'Response time'),
        p ? h('div.row.muted', { style: { fontSize: '12.5px', gap: '14px' } }, ['p50', 'p95', 'p99'].map((k) => h('span', k + ' ', h('b', { style: { color: 'var(--text)' } }, ms(p[k]))))) : null,
        h('div.seg', RANGES.map((r) => h('button', { class: r === range ? 'on' : '', onclick: () => { range = r; renderChart(); } }, r)))),
      h('div.body', { style: { padding: '12px 16px 8px' } }, m.type === 'push' ? h('p.muted', 'Heartbeat monitors have no latency — see the check log below.') : latencyChart(data, { height: 240 })));
    mount(stripEl, h('div.row', { style: { marginBottom: '10px' } }, h('h2.grow', '90-day uptime'), h('span.muted', `${pct(data.uptime['90d'])} overall`)), uptimeStrip(data.daily));
  }

  async function renderChecks() {
    const { checks } = await api.get(`/api/monitors/${id}/checks?limit=25`);
    if (stopped) return;
    mount(checksEl, h('header', h('h2', 'Recent checks')),
      checks.length ? h('div.scroll-x', h('table.tbl', h('thead', h('tr', ['Time', 'Result', 'Latency', 'Code', 'Detail'].map((t) => h('th', t)))),
        h('tbody', checks.map((c) => h('tr', h('td.nowrap', dateTime(c.ts)), h('td', c.maintenance ? statusBadge('maintenance', 'Maintenance') : statusBadge(c.ok ? 'up' : 'down', c.ok ? 'OK' : 'Failed')),
          h('td.mono', c.ok ? ms(c.latencyMs) : '—'), h('td.mono', c.statusCode ?? '—'), h('td.muted', { style: { maxWidth: '360px' } }, c.error ?? '')))))) : empty('clock', 'No checks yet', 'The first check runs within a few seconds of creating a monitor.'));
    const { incidents } = await api.get(`/api/monitors/${id}/incidents`);
    mount(incidentsEl, h('header', h('h2', 'Incidents')),
      incidents.length ? h('table.tbl', h('tbody', incidents.slice(0, 8).map((i) => h('tr.link', { onclick: () => go(`/incidents/${i.id}`) },
        h('td', statusBadge(i.open ? 'open' : 'resolved')), h('td.nowrap', dateTime(i.startedAt)), h('td.nowrap', duration(i.durationMs)), h('td.muted', i.cause ?? ''))))) : empty('shield', 'No incidents', 'This monitor has a clean record.'));
  }

  function renderDetail() {
    const c = m.config, rows = [];
    const add = (k, v) => v !== undefined && v !== null && v !== '' && rows.push([k, v]);
    add('Interval', `every ${duration(m.intervalS * 1000)}`); add('Timeout', duration(m.timeoutMs));
    add('Down after', `${m.retries} consecutive failure${m.retries > 1 ? 's' : ''}`);
    if (m.type === 'http') { add('Method', c.method); add('Expected status', c.expectedStatus); add('Keyword', c.keyword && `${c.keywordMode === 'absent' ? 'must not contain' : 'contains'} “${c.keyword}”`); add('JSON path', c.jsonPath && `${c.jsonPath}${c.jsonExpected ? ' = ' + c.jsonExpected : ''}`); }
    const t = m.lastMeta?.timings;
    if (t) add('Last timings', ['dns', 'connect', 'tls', 'ttfb', 'total'].filter((k) => t[k] != null).map((k) => `${k} ${t[k]}ms`).join('  ·  '));
    if (m.certExpiresAt) add('TLS certificate', `expires ${fullDate(m.certExpiresAt)} (${Math.floor((m.certExpiresAt - Date.now()) / 86400000)} days)`);
    if (m.lastMeta?.answers) add('DNS answers', m.lastMeta.answers.join(', '));
    add('Created', fullDate(m.createdAt));
    mount(detailEl, h('header', h('h2', 'Configuration')), h('table.tbl', h('tbody', rows.map(([k, v]) => h('tr', h('td.muted.nowrap', { style: { width: '160px' } }, k), h('td', v))))),
      m.type === 'push' ? h('div.body', { style: { borderTop: '1px solid var(--border)' } }, h('div.stack', { style: { gap: '10px' } },
        h('b', 'Heartbeat URL'), h('p.muted', 'Call this URL from your job when it succeeds. Add ', h('code', '?status=down&msg=…'), ' to report a failure.'),
        copyBox(`${location.origin}/api/push/${m.pushToken}`),
        copyBox(`curl -fsS -m 10 --retry 3 ${location.origin}/api/push/${m.pushToken}`))) : null);
  }

  async function reload() {
    m = await api.get(`/api/monitors/${id}`);
    renderHead(); renderStats(); renderDetail(); await Promise.all([renderChart(), renderChecks()]);
  }

  mount(root, headEl, statsEl, h('div.stack', { style: { marginTop: '16px' } }, chartCard, stripEl, h('div.grid.cols-2', checksEl, h('div.stack', incidentsEl, detailEl))));
  renderHead(); renderStats(); renderDetail();
  await Promise.all([renderChart(), renderChecks()]);

  const offs = [
    store.on('check', (c) => { if (c.monitorId === Number(id)) raf(() => reload().catch(() => {})); }),
  ];
  const tick = setInterval(() => reload().catch(() => {}), 60_000);
  return () => { stopped = true; offs.forEach((f) => f()); clearInterval(tick); };
}
