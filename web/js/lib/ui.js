import { h, icon } from './dom.js';

export function toast(message, kind = 'info', ms = 3800) {
  const el = h('div.toast', { class: ['toast', kind] }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

 
export function modal({ title, body, footer, wide = false, onClose }) {
  const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } });
  const el = h('div.modal', { class: wide ? 'modal wide' : 'modal', role: 'dialog', 'aria-modal': 'true' },
    h('header', h('h2', title), h('button.btn.ghost.icon', { onclick: () => close(), 'aria-label': 'Close' }, icon('x'))),
    h('div.body', body),
    footer ? h('footer', footer) : null);
  overlay.append(el);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); onClose?.(); }
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  const first = el.querySelector('input, select, textarea');
  first?.focus();
  return { close, el };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal({
      title, body: h('p', message), onClose: () => finish(false),
      footer: [
        h('button.btn', { onclick: () => { finish(false); m.close(); } }, 'Cancel'),
        h('button.btn', { class: danger ? 'btn danger' : 'btn primary', onclick: () => { finish(true); m.close(); } }, confirmLabel),
      ],
    });
  });
}

export function copyText(text, label = 'Copied') {
  navigator.clipboard?.writeText(text).then(() => toast(label, 'ok'), () => toast('Copy failed', 'err'));
}

export function copyBox(text) {
  return h('div.copybox', h('code', text), h('button.btn.sm', { onclick: () => copyText(text) }, icon('copy', 14), 'Copy'));
}

export function empty(iconName, title, text, action) {
  return h('div.empty', icon(iconName, 34), h('h3', title), text ? h('p', text) : null, action ? h('div', { style: { marginTop: '14px' } }, action) : null);
}

export function statusBadge(status, label) {
  const text = label ?? ({ up: 'Up', down: 'Down', pending: 'Checking', paused: 'Paused', maintenance: 'Maintenance', operational: 'Operational', degraded: 'Degraded', outage: 'Outage', partial_outage: 'Partial outage', open: 'Open', resolved: 'Resolved' }[status] ?? status);
  return h('span', { class: ['badge', status] }, h('i'), text);
}

 
export function showFieldErrors(form, details = {}) {
  form.querySelectorAll('.err[data-for]').forEach((e) => e.remove());
  form.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
  let firstEl = null;
  for (const [field, msg] of Object.entries(details)) {
    const input = form.querySelector(`[name="${CSS.escape(field)}"]`);
    if (!input) continue;
    input.classList.add('invalid');
    const wrap = input.closest('label.field') ?? input.parentElement;
    wrap.append(h('span.err', { 'data-for': field }, msg));
    firstEl ??= input;
  }
  firstEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return Object.keys(details).filter((f) => !form.querySelector(`[name="${CSS.escape(f)}"]`));
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export const raf = (() => { let queued = new Set(); return (fn) => { if (!queued.size) requestAnimationFrame(() => { const q = queued; queued = new Set(); q.forEach((f) => f()); }); queued.add(fn); }; })();
