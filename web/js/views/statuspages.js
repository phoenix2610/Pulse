import { h, mount, icon } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { empty, modal, toast, confirmDialog, showFieldErrors, copyBox, statusBadge } from '../lib/ui.js';
import { dateTime } from '../lib/format.js';

export async function statusPagesView(root) {
  const body = h('div.stack');
  mount(root, h('div.page-head', h('div.grow', h('h1', 'Status pages'), h('div.sub', 'Public pages your customers can check — no login needed.')),
    h('button.btn.primary', { onclick: () => edit() }, icon('plus', 15), 'New status page')), body);

  async function load() {
    const [{ pages }, { monitors }] = await Promise.all([api.get('/api/status-pages'), api.get('/api/monitors')]);
    if (!pages.length) return mount(body, h('div.card', empty('globe', 'No status pages', 'Publish a page with the monitors you choose. Internal monitors stay private.', h('button.btn.primary', { onclick: () => edit(null, monitors) }, icon('plus', 15), 'Create status page'))));
    mount(body, h('div.grid.auto', pages.map((p) => {
      const url = `${location.origin}/status/${p.slug}`;
      return h('div.card.pad.stack', { style: { gap: '10px' } },
        h('div.row', h('b.grow', p.title), h('span.tag', `${p.monitors.length} monitor${p.monitors.length === 1 ? '' : 's'}`)),
        copyBox(url),
        h('div.row', h('a.btn.sm', { href: url, target: '_blank', rel: 'noopener' }, icon('external', 13), 'Open'), h('button.btn.sm', { onclick: () => edit(p, monitors) }, icon('edit', 13), 'Edit'),
          h('button.btn.sm', { onclick: () => announce(p) }, icon('bell', 13), `Announcements${p.announcements.length ? ` (${p.announcements.length})` : ''}`),
          h('button.btn.sm.danger', { onclick: async () => { if (await confirmDialog({ title: 'Delete status page', message: `Delete “${p.title}”? The public URL will stop working.`, confirmLabel: 'Delete', danger: true })) { await api.del(`/api/status-pages/${p.id}`); load(); } } }, icon('trash', 13))),
        p.monitors.length ? h('details', h('summary.muted', { style: { cursor: 'pointer', fontSize: '12.5px' } }, 'Embeddable badges'), h('div.stack', { style: { gap: '8px', marginTop: '8px' } },
          p.monitors.slice(0, 3).map((m) => h('div.stack', { style: { gap: '4px' } }, h('img', { src: `/badge/${m.monitorId}/status.svg`, alt: m.name, style: { height: '20px', width: 'auto', alignSelf: 'flex-start' } }), copyBox(`![${m.name}](${location.origin}/badge/${m.monitorId}/status.svg)`))))) : null);
    })));
  }

  async function edit(p, monitors) {
    monitors ??= (await api.get('/api/monitors')).monitors;
    const selected = new Map((p?.monitors ?? []).map((m) => [m.monitorId, m.label ?? '']));
    const list = h('div', { style: { maxHeight: '260px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' } }, monitors.map((m) => {
      const cb = h('input', { type: 'checkbox', value: m.id, checked: selected.has(m.id), onchange: () => label.classList.toggle('hidden', !cb.checked) });
      const label = h('input', { placeholder: 'Public label (optional)', value: selected.get(m.id) ?? '', 'data-label': m.id, class: selected.has(m.id) ? '' : 'hidden', style: { padding: '4px 8px', maxWidth: '220px' } });
      return h('div.row', { style: { flexWrap: 'nowrap' } }, h('label.check.grow', cb, m.name), label);
    }));
    const slugInput = h('input', { name: 'slug', value: p?.slug ?? '', required: true, pattern: '[a-z0-9]+(-[a-z0-9]+)*', placeholder: 'acme' });
    const titleInput = h('input', { name: 'title', value: p?.title ?? '', required: true, placeholder: 'Acme Status', oninput: (e) => { if (!p && !slugInput.dataset.touched) slugInput.value = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); } });
    slugInput.addEventListener('input', () => { slugInput.dataset.touched = '1'; });
    const form = h('form.stack', { onsubmit: (e) => { e.preventDefault(); save(); } },
      h('label.field', 'Title', titleInput), h('label.field', 'URL slug', slugInput, h('span.hint', `${location.origin}/status/`)),
      h('label.field', 'Description', h('textarea', { name: 'description', rows: 2, style: { fontFamily: 'var(--sans)' } }, p?.description ?? '')),
      h('div.stack', { style: { gap: '6px' } }, h('b', { style: { fontSize: '13px' } }, 'Monitors to show'), list));
    const m = modal({ title: p ? 'Edit status page' : 'New status page', body: form, wide: true, footer: [h('button.btn', { onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { onclick: () => save() }, 'Save')] });
    async function save() {
      const fd = new FormData(form);
      const body = { slug: fd.get('slug'), title: fd.get('title'), description: fd.get('description') || null,
        monitors: [...list.querySelectorAll('input[type=checkbox]:checked')].map((cb) => ({ monitorId: Number(cb.value), label: list.querySelector(`[data-label="${cb.value}"]`).value.trim() || null })) };
      try { p ? await api.put(`/api/status-pages/${p.id}`, body) : await api.post('/api/status-pages', body); m.close(); toast('Status page saved', 'ok'); load(); }
      catch (e) { if (e instanceof ApiError && e.details) { const left = showFieldErrors(form, e.details); if (left.length) toast(left.map((k) => `${k} ${e.details[k]}`).join('; '), 'err'); } else toast(e.message, 'err'); }
    }
  }

  function announce(p) {
    const listEl = h('div.stack', { style: { gap: '8px' } });
    const draw = (items) => mount(listEl, items.length ? items.map((a) => h('div', { class: 'announce ' + a.level }, h('div.row', h('b.grow', a.title), h('span.faint', dateTime(a.createdAt)),
      h('button.btn.sm.ghost', { onclick: async () => { await api.del(`/api/status-pages/${p.id}/announcements/${a.id}`); p.announcements = p.announcements.filter((x) => x.id !== a.id); draw(p.announcements); load(); } }, icon('trash', 12))), a.body ? h('span', a.body) : null)) : h('p.muted', 'No announcements.'));
    draw(p.announcements);
    const form = h('form.stack', { onsubmit: async (e) => { e.preventDefault(); const fd = new FormData(form); try { const r = await api.post(`/api/status-pages/${p.id}/announcements`, { title: fd.get('title'), body: fd.get('body') || null, level: fd.get('level') }); p.announcements = r.announcements; draw(r.announcements); form.reset(); load(); } catch (err) { toast(err.message, 'err'); } } },
      h('label.field', 'Title', h('input', { name: 'title', required: true, placeholder: 'Investigating elevated error rates' })),
      h('label.field', 'Details', h('textarea', { name: 'body', rows: 2, style: { fontFamily: 'var(--sans)' } })),
      h('div.row', h('select', { name: 'level', style: { width: 'auto' } }, ['info', 'warning', 'critical'].map((l) => h('option', { value: l }, l))), h('button.btn.primary', { type: 'submit' }, 'Publish')));
    const m = modal({ title: `Announcements — ${p.title}`, body: h('div.stack', form, h('hr', { style: { border: 0, borderTop: '1px solid var(--border)', width: '100%' } }), listEl), footer: [h('button.btn', { onclick: () => m.close() }, 'Close')] });
  }
  await load();
}
