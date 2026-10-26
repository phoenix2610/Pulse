import { h, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { showFieldErrors } from '../lib/ui.js';

function authForm({ title, subtitle, fields, submitLabel, onSubmit }) {
  const error = h('div.err', { style: { minHeight: '18px' } });
  const btn = h('button.btn.primary', { type: 'submit', style: { width: '100%', padding: '10px' } }, submitLabel);
  const form = h('form.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      btn.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(form)));
      } catch (err) {
        error.textContent = err.message;
        if (err.details) showFieldErrors(form, err.details);
        btn.disabled = false;
      }
    },
  }, fields.map(([name, label, type, extra]) => h('label.field', label, h('input', { name, type, required: true, autocomplete: extra?.autocomplete, minlength: extra?.minlength, placeholder: extra?.placeholder }))), error, btn);
  return h('div.auth', h('div.card',
    h('div.row', { style: { color: 'var(--green)' } }, icon('activity', 28), h('b', { style: { fontSize: '20px', color: 'var(--text)' } }, 'Pulse')),
    h('h1', title), h('p.muted', { style: { marginBottom: '20px' } }, subtitle), form));
}

export function loginView(onAuth) {
  return authForm({
    title: 'Welcome back', subtitle: 'Sign in to your monitoring dashboard.', submitLabel: 'Sign in',
    fields: [['email', 'Email', 'email', { autocomplete: 'username' }], ['password', 'Password', 'password', { autocomplete: 'current-password' }]],
    onSubmit: async (v) => onAuth((await api.post('/api/auth/login', v)).user),
  });
}

export function setupView(onAuth) {
  return authForm({
    title: 'Set up Pulse', subtitle: 'Create the first admin account. You can add monitors right after.', submitLabel: 'Create account',
    fields: [['name', 'Your name', 'text', { autocomplete: 'name' }], ['email', 'Email', 'email', { autocomplete: 'username' }], ['password', 'Password (min 8 characters)', 'password', { autocomplete: 'new-password', minlength: 8 }]],
    onSubmit: async (v) => onAuth((await api.post('/api/setup', v)).user),
  });
}
