import { h, mount, icon } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { store } from '../lib/store.js';
import { ago, dateTime } from '../lib/format.js';
import { toast, modal, copyBox, confirmDialog, showFieldErrors, empty } from '../lib/ui.js';

export async function settingsView(root) {
  const [settings, tokens, sessions] = await Promise.all([api.get('/api/settings'), api.get('/api/tokens'), api.get('/api/auth/sessions')]);
  const tokensEl = h('div');

  const settingsForm = h('form.stack', { onsubmit: async (e) => {
    e.preventDefault(); const fd = new FormData(settingsForm);
    try { await api.put('/api/settings', { baseUrl: fd.get('baseUrl') || '', certWarnDays: Number(fd.get('certWarnDays')) }); toast('Settings saved', 'ok'); } catch (err) { if (err.details) showFieldErrors(settingsForm, err.details); toast(err.message, 'err'); }
  } },
    h('label.field', 'Public base URL', h('input', { name: 'baseUrl', value: settings.baseUrl ?? '', placeholder: 'https://status.example.com', type: 'url' }), h('span.hint', 'Used for links inside alert messages.')),
    h('label.field', 'Certificate warning threshold (days)', h('input', { name: 'certWarnDays', type: 'number', min: 1, max: 90, value: settings.certWarnDays })),
    h('div', h('button.btn.primary', { type: 'submit' }, 'Save settings')));

  const profileForm = h('form.stack', { onsubmit: async (e) => { e.preventDefault(); try { const r = await api.put('/api/auth/profile', { name: new FormData(profileForm).get('name') }); store.user = r.user; toast('Profile updated', 'ok'); } catch (err) { toast(err.message, 'err'); } } },
    h('label.field', 'Display name', h('input', { name: 'name', value: store.user.name, required: true })), h('div', h('button.btn', { type: 'submit' }, 'Update name')));

  const pwForm = h('form.stack', { onsubmit: async (e) => {
    e.preventDefault(); const fd = new FormData(pwForm);
    try { await api.post('/api/auth/password', { current: fd.get('current'), next: fd.get('next') }); pwForm.reset(); toast('Password changed — other sessions signed out', 'ok'); } catch (err) { if (err instanceof ApiError && err.details) showFieldErrors(pwForm, err.details); toast(err.message, 'err'); }
  } },
    h('label.field', 'Current password', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label.field', 'New password', h('input', { name: 'next', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })), h('div', h('button.btn', { type: 'submit' }, 'Change password')));

  async function loadTokens() {
    const list = await api.get('/api/tokens');
    mount(tokensEl, list.length ? h('table.tbl', h('tbody', list.map((t) => h('tr', h('td', h('b', t.name), t.readOnly ? h('span.tag', { style: { marginLeft: '8px' } }, 'read-only') : null), h('td.mono.muted', `${t.prefix}…`),
      h('td.muted.nowrap', t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : 'never used'), h('td.right', h('button.btn.sm.danger', { onclick: async () => { if (await confirmDialog({ title: 'Revoke token', message: `Revoke “${t.name}”? Anything using it will stop working.`, confirmLabel: 'Revoke', danger: true })) { await api.del(`/api/tokens/${t.id}`); loadTokens(); } } }, 'Revoke')))))) : h('p.muted', { style: { padding: '16px' } }, 'No API tokens yet.'));
  }

  function newToken() {
    const form = h('form.stack', { onsubmit: (e) => { e.preventDefault(); create(); } },
      h('label.field', 'Name', h('input', { name: 'name', required: true, placeholder: 'CI pipeline' })), h('label.check', h('input', { type: 'checkbox', name: 'readOnly' }), 'Read-only (can’t create, edit or delete)'));
    const m = modal({ title: 'New API token', body: form, footer: [h('button.btn', { onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { onclick: () => create() }, 'Create token')] });
    async function create() {
      const fd = new FormData(form);
      try {
        const r = await api.post('/api/tokens', { name: fd.get('name'), readOnly: form.querySelector('[name=readOnly]').checked });
        m.close(); loadTokens();
        const m2 = modal({ title: 'Copy your token', body: h('div.stack', h('div.banner', 'This is the only time it will be shown.'), copyBox(r.secret), h('p.muted', 'Use it as ', h('code', 'Authorization: Bearer <token>'))), footer: [h('button.btn.primary', { onclick: () => m2.close() }, 'Done')] });
      } catch (e) { toast(e.message, 'err'); }
    }
  }

  const importInput = h('input', { type: 'file', accept: 'application/json', class: 'hidden', onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = await api.post('/api/import', JSON.parse(await f.text())); toast(`Imported ${r.imported.monitors} monitors, ${r.imported.channels} channels, ${r.imported.statusPages} status pages`, 'ok', 6000); } catch (err) { toast(`Import failed: ${err.message}`, 'err', 6000); }
    e.target.value = '';
  } });

  const card = (title, ...kids) => h('div.card', h('header', h('h2', title)), h('div.body', ...kids));
  mount(root, h('div.page-head', h('div.grow', h('h1', 'Settings'))),
    h('div.grid.cols-2', { style: { alignItems: 'start' } },
      h('div.stack', card('General', settingsForm), card('Profile', profileForm), card('Password', pwForm)),
      h('div.stack',
        h('div.card', h('header', h('h2', 'API tokens'), h('button.btn.sm.primary', { onclick: newToken }, icon('plus', 13), 'New token')), tokensEl),
        card('Backup & migration', h('p.muted', { style: { marginBottom: '12px' } }, 'Export monitors, channels (including secrets) and status pages as JSON. History is not included.'),
          h('div.row', h('a.btn', { href: '/api/export', download: 'pulse-export.json' }, icon('download', 14), 'Export'), h('button.btn', { onclick: () => importInput.click() }, icon('upload', 14), 'Import'), importInput)),
        card('Signed-in sessions', sessions.length ? h('div.stack', { style: { gap: '8px' } }, sessions.map((s) => h('div.row', h('span.grow.truncate', (s.userAgent ?? 'Unknown device').replace(/\(.*?\)/, '').slice(0, 60)), h('span.faint', `${s.ip ?? ''} · ${dateTime(s.createdAt)}`)))) : h('p.muted', 'No sessions')),
        card('Retention', h('p.muted', `Raw checks are kept ${settings.retention.rawDays} days; hourly rollups ${settings.retention.rollupDays} days. Change via PULSE_RAW_RETENTION_DAYS / PULSE_ROLLUP_RETENTION_DAYS.`)))));
  await loadTokens();
}
