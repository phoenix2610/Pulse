import { h, mount, icon } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { dateTime, duration, toLocalInput, fromLocalInput } from '../lib/format.js';
import { empty, modal, toast, confirmDialog, statusBadge, showFieldErrors } from '../lib/ui.js';

export async function maintenanceView(root) {
  const body = h('div.card');
  mount(root, h('div.page-head', h('div.grow', h('h1', 'Maintenance windows'), h('div.sub', 'Planned work. Checks still run, but no incidents open and no alerts fire — and the time is excluded from uptime.')),
    h('button.btn.primary', { onclick: () => edit() }, icon('plus', 15), 'Schedule window')), body);
  let monitors = [];

  async function load() {
    const [{ maintenance }, mons] = await Promise.all([api.get('/api/maintenance'), api.get('/api/monitors')]);
    monitors = mons.monitors;
    if (!maintenance.length) return mount(body, empty('wrench', 'No maintenance scheduled', 'Schedule a window before deploys or migrations so your uptime stays honest.'));
    const names = (ids) => (ids.length ? ids.map((i) => monitors.find((m) => m.id === i)?.name ?? `#${i}`).join(', ') : 'All monitors');
    mount(body, h('div.scroll-x', h('table.tbl', h('thead', h('tr', ['State', 'Name', 'Starts', 'Ends', 'Duration', 'Affects', ''].map((t) => h('th', t)))),
      h('tbody', maintenance.map((w) => h('tr', h('td', statusBadge(w.state, w.state === 'past' ? 'Past' : w.state === 'active' ? 'Active' : 'Scheduled')), h('td', { style: { fontWeight: 600 } }, w.name),
        h('td.nowrap', dateTime(w.startsAt)), h('td.nowrap', dateTime(w.endsAt)), h('td.nowrap', duration(w.endsAt - w.startsAt)), h('td.muted.truncate', { style: { maxWidth: '260px' } }, names(w.monitorIds)),
        h('td.right.nowrap', h('button.btn.sm.ghost', { onclick: () => edit(w) }, icon('edit', 13)), h('button.btn.sm.ghost', { onclick: async () => { if (await confirmDialog({ title: 'Delete window', message: `Delete “${w.name}”?`, confirmLabel: 'Delete', danger: true })) { await api.del(`/api/maintenance/${w.id}`); load(); } } }, icon('trash', 13)))))))));
  }

  function edit(w) {
    const start = w?.startsAt ?? Date.now() + 15 * 60_000;
    const form = h('form.stack', { onsubmit: (e) => { e.preventDefault(); save(); } },
      h('label.field', 'Name', h('input', { name: 'name', value: w?.name ?? '', required: true, placeholder: 'Database upgrade' })),
      h('div.form-grid', h('label.field', 'Starts', h('input', { type: 'datetime-local', name: 'startsAt', value: toLocalInput(start), required: true })), h('label.field', 'Ends', h('input', { type: 'datetime-local', name: 'endsAt', value: toLocalInput(w?.endsAt ?? start + 3600_000), required: true }))),
      h('div.stack', { style: { gap: '6px' } }, h('b', { style: { fontSize: '13px' } }, 'Affected monitors'), h('span.hint.faint', 'Leave all unchecked to cover every monitor.'),
        h('div', { style: { maxHeight: '200px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' } }, monitors.map((m) => h('label.check', h('input', { type: 'checkbox', name: 'm', value: m.id, checked: w?.monitorIds.includes(m.id) }), m.name)))));
    const m = modal({ title: w ? 'Edit maintenance window' : 'Schedule maintenance', body: form, footer: [h('button.btn', { onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { onclick: () => save() }, 'Save')] });
    async function save() {
      const fd = new FormData(form);
      const body = { name: fd.get('name'), startsAt: fromLocalInput(fd.get('startsAt')), endsAt: fromLocalInput(fd.get('endsAt')), monitorIds: [...form.querySelectorAll('[name=m]:checked')].map((x) => Number(x.value)) };
      try { w ? await api.put(`/api/maintenance/${w.id}`, body) : await api.post('/api/maintenance', body); m.close(); toast('Saved', 'ok'); load(); }
      catch (e) { if (e instanceof ApiError && e.details) { const left = showFieldErrors(form, e.details); if (left.length) toast(left.map((k) => `${k} ${e.details[k]}`).join('; '), 'err'); } else toast(e.message, 'err'); }
    }
  }
  await load();
}
