import { h, mount, icon, $ } from './lib/dom.js';
import { api, setUnauthorizedHandler } from './lib/api.js';
import { createRouter, go } from './lib/router.js';
import { store } from './lib/store.js';
import { initials } from './lib/format.js';
import { toast } from './lib/ui.js';
import { loginView, setupView } from './views/login.js';
import { dashboardView } from './views/dashboard.js';
import { monitorView } from './views/monitor.js';
import { monitorFormView } from './views/monitor-form.js';
import { incidentsView, incidentView } from './views/incidents.js';
import { channelsView } from './views/channels.js';
import { maintenanceView } from './views/maintenance.js';
import { statusPagesView } from './views/statuspages.js';
import { settingsView } from './views/settings.js';

const app = document.getElementById('app');
const theme = (() => { try { return localStorage.getItem('pulse-theme'); } catch { return null; } })() || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
document.documentElement.dataset.theme = theme;

const NAV = [
  ['/', 'grid', 'Monitors'], ['/incidents', 'alert', 'Incidents'], ['/channels', 'bell', 'Alert channels'],
  ['/maintenance', 'wrench', 'Maintenance'], ['/status-pages', 'globe', 'Status pages'], ['/settings', 'settings', 'Settings'],
];

let shell = null;
function buildShell() {
  const liveEl = h('div.live', h('i'), h('span', 'Connecting…'));
  const openBadge = h('span.count.hidden', '0');
  const sidebar = h('aside.sidebar',
    h('div.brand', icon('activity', 22), 'Pulse'),
    h('nav.nav', NAV.map(([path, ic, label]) => h('a', { href: '#' + path, 'data-path': path }, icon(ic, 17), label, path === '/incidents' ? openBadge : null))),
    h('div.spacer'), liveEl,
    h('div.userbox',
      h('div.avatar', initials(store.user.name)),
      h('div.grow', h('div.truncate', { style: { fontWeight: 600 } }, store.user.name), h('div.truncate.faint', { style: { fontSize: '12px' } }, store.user.email)),
      h('button.btn.ghost.icon', { title: 'Toggle theme', onclick: toggleTheme }, icon('sun', 16)),
      h('button.btn.ghost.icon', { title: 'Sign out', onclick: logout }, icon('logout', 16))));
  const content = h('main.main');
  const topbar = h('div.topbar', h('button.btn.ghost.icon', { onclick: () => sidebar.classList.toggle('open') }, icon('menu', 20)), h('div.brand', { style: { padding: 0 } }, icon('activity', 20), 'Pulse'));
  const el = h('div.shell', sidebar, h('div', topbar, content));
  sidebar.addEventListener('click', (e) => { if (e.target.closest('a')) sidebar.classList.remove('open'); });

  store.on('live', (on) => { liveEl.classList.toggle('on', on); liveEl.lastChild.textContent = on ? 'Live' : 'Reconnecting…'; });
  const updateBadge = () => {
    const n = store.summary?.openIncidents?.length ?? 0;
    openBadge.textContent = n; openBadge.classList.toggle('hidden', n === 0);
  };
  store.on('summary', updateBadge);
  return { el, content, sidebar, updateBadge };
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('pulse-theme', next); } catch {   }
  router.refresh();  
}

async function logout() {
  await api.post('/api/auth/logout').catch(() => {});
  store.disconnect(); store.user = null; shell = null;
  boot();
}

const wrap = (view) => (params, query) => view(shell.content, params, query);
const router = createRouter([
  ['/', wrap(dashboardView)],
  ['/monitors/new', wrap((c, p, q) => monitorFormView(c, { ...p, id: null }, q))],
  ['/monitors/:id/edit', wrap(monitorFormView)],
  ['/monitors/:id', wrap(monitorView)],
  ['/incidents', wrap(incidentsView)],
  ['/incidents/:id', wrap(incidentView)],
  ['/channels', wrap(channelsView)],
  ['/maintenance', wrap(maintenanceView)],
  ['/status-pages', wrap(statusPagesView)],
  ['/settings', wrap(settingsView)],
], {
  onChange: ({ path }) => {
    if (!shell) return;
    shell.el.querySelectorAll('.nav a').forEach((a) => {
      const p = a.dataset.path;
      a.classList.toggle('active', p === '/' ? path === '/' || path.startsWith('/monitors') : path.startsWith(p));
    });
    window.scrollTo(0, 0);
  },
});

async function boot() {
  try {
    const { needsSetup } = await api.get('/api/setup/status');
    if (needsSetup) return mount(app, setupView(afterAuth));
    try {
      const me = await api.get('/api/auth/me');
      store.user = me.user;
      return start();
    } catch { return mount(app, loginView(afterAuth)); }
  } catch (e) {
    mount(app, h('div.boot', h('div.stack', { style: { textAlign: 'center' } }, h('h2', 'Cannot reach the Pulse server'), h('p.muted', e.message), h('button.btn', { onclick: () => location.reload() }, 'Retry'))));
  }
}
async function afterAuth(user) { store.user = user; start(); }

async function start() {
  shell = buildShell();
  mount(app, shell.el);
  store.connect();
  store.loadSummary().then(shell.updateBadge).catch(() => {});
  if (!location.hash) location.hash = '#/';
  router.start();
}

setUnauthorizedHandler(() => {
  if (!store.user) return;
  store.user = null; store.disconnect(); shell = null;
  toast('Your session expired — please sign in again', 'err');
  mount(app, loginView(afterAuth));
});

boot();
