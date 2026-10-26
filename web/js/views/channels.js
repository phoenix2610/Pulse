import { h, mount, icon } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { ago, dateTime } from '../lib/format.js';
import { empty, modal, toast, confirmDialog, showFieldErrors, statusBadge } from '../lib/ui.js';

const TYPES = {
  webhook: { label: 'Webhook', hint: 'JSON POST, optionally HMAC-signed (X-Pulse-Signature).', fields: [['url', 'Endpoint URL', 'url', true], ['secret', 'Signing secret (optional)', 'password']] },
  slack: { label: 'Slack', hint: 'Incoming webhook.', fields: [['webhookUrl', 'Webhook URL', 'url', true]] },
  discord: { label: 'Discord', hint: 'Channel webhook with rich embeds.', fields: [['webhookUrl', 'Webhook URL', 'url', true], ['mention', 'Mention on down (e.g. @here)', 'text']] },
  telegram: { label: 'Telegram', hint: 'Bot API message.', fields: [['botToken', 'Bot token', 'password', true], ['chatId', 'Chat ID', 'text', true]] },
  ntfy: { label: 'ntfy', hint: 'Push notifications to your phone.', fields: [['server', 'Server', 'url'], ['topic', 'Topic', 'text', true], ['token', 'Access token (optional)', 'password']] },
  email: { label: 'Email (SMTP)', hint: 'Direct SMTP, STARTTLS or implicit TLS.', fields: [['host', 'SMTP host', 'text', true], ['port', 'Port', 'number'], ['user', 'Username', 'text'], ['password', 'Password', 'password'], ['from', 'From address', 'email', true], ['to', 'Recipients (comma separated)', 'text', true]] },
};

export async function channelsView(root) {
  const list = h('div.stack'), logEl = h('div.card');
  mount(root, h('div.page-head', h('div.grow', h('h1', 'Alert channels'), h('div.sub', 'Where Pulse sends incident and recovery notifications.')),
    h('button.btn.primary', { onclick: () => edit() }, icon('plus', 15), 'Add channel')), list, h('div', { style: { height: '24px' } }), logEl);

  async function load() {
    const [{ channels }, { log }] = await Promise.all([api.get('/api/channels'), api.get('/api/channels/log?limit=15')]);
    if (!channels.length) mount(list, h('div.card', empty('bell', 'No channels yet', 'Add Slack, Discord, email, Telegram, ntfy or a webhook to get alerted the moment something breaks.', h('button.btn.primary', { onclick: () => edit() }, icon('plus', 15), 'Add channel'))));
    else mount(list, h('div.grid.auto', channels.map((c) => h('div.card.pad.stack', { style: { gap: '10px' } },
      h('div.row', h('b.grow', c.name), h('span.tag', TYPES[c.type]?.label ?? c.type), c.enabled ? null : statusBadge('paused', 'Disabled')),
      h('div.muted', { style: { fontSize: '12.5px' } }, c.applyAll ? 'Applies to all monitors' : `${c.monitorIds.length} monitor${c.monitorIds.length === 1 ? '' : 's'}`),
      h('div.row', h('button.btn.sm', { onclick: (e) => test(c, e.currentTarget) }, icon('zap', 13), 'Send test'), h('button.btn.sm', { onclick: () => edit(c) }, icon('edit', 13), 'Edit'),
        h('button.btn.sm.danger', { onclick: async () => { if (await confirmDialog({ title: 'Delete channel', message: `Delete “${c.name}”?`, confirmLabel: 'Delete', danger: true })) { await api.del(`/api/channels/${c.id}`); load(); } } }, icon('trash', 13)))))));
    mount(logEl, h('header', h('h2', 'Recent deliveries')), log.length ? h('div.scroll-x', h('table.tbl', h('tbody', log.map((l) => h('tr', h('td.nowrap', dateTime(l.ts)), h('td', l.channelName ?? '—'), h('td', h('span.tag', l.event)), h('td', statusBadge(l.ok ? 'up' : 'down', l.ok ? 'Delivered' : 'Failed')), h('td.muted', l.error ?? '')))))) : empty('clock', 'Nothing sent yet'));
  }

  async function test(c, btn) {
    btn.disabled = true;
    try { const r = await api.post(`/api/channels/${c.id}/test`); toast(r.ok ? 'Test notification delivered' : `Delivery failed: ${r.error}`, r.ok ? 'ok' : 'err', 6000); } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false; load();
  }

  async function edit(c) {
    const { monitors } = await api.get('/api/monitors');
    let type = c?.type ?? 'webhook';
    const fieldsEl = h('div.form-grid');
    const draw = () => {
      const cfg = type === c?.type ? c.config : {};
      mount(fieldsEl, h('p.muted.full', TYPES[type].hint), TYPES[type].fields.map(([k, label, inputType, req]) => h('label.field', { class: 'field' + (['url', 'webhookUrl', 'host'].includes(k) ? ' full' : '') }, label,
        h('input', { name: `config.${k}`, type: inputType === 'password' || inputType === 'url' && false ? 'password' : inputType, value: Array.isArray(cfg[k]) ? cfg[k].join(', ') : cfg[k] ?? '', required: req && !c, autocomplete: 'off', placeholder: c && cfg[k] ? '(unchanged)' : '' }))));
    };
    draw();
    const form = h('form.stack', { onsubmit: (e) => { e.preventDefault(); save(); } },
      h('label.field', 'Name', h('input', { name: 'name', value: c?.name ?? '', required: true, placeholder: 'On-call Slack' })),
      c ? null : h('label.field', 'Type', h('select', { name: 'type', onchange: (e) => { type = e.target.value; draw(); } }, Object.entries(TYPES).map(([v, t]) => h('option', { value: v, selected: v === type }, t.label)))),
      fieldsEl,
      h('label.check', h('input', { type: 'checkbox', name: 'enabled', checked: c?.enabled ?? true }), 'Enabled'),
      h('label.check', h('input', { type: 'checkbox', name: 'applyAll', checked: c?.applyAll ?? false }), 'Use for all monitors (including future ones)'),
      h('div.stack', { style: { gap: '6px' } }, h('b', { style: { fontSize: '13px' } }, 'Or pick specific monitors'),
        h('div', { style: { maxHeight: '160px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' } }, monitors.length ? monitors.map((m) => h('label.check', h('input', { type: 'checkbox', name: 'm', value: m.id, checked: c?.monitorIds.includes(m.id) }), m.name)) : h('span.muted', 'No monitors yet'))));
    const m = modal({ title: c ? `Edit ${c.name}` : 'Add alert channel', body: form, wide: true, footer: [h('button.btn', { onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { onclick: () => save() }, c ? 'Save' : 'Create channel')] });
    async function save() {
      const fd = new FormData(form);
      const config = {};
      for (const [k, v] of fd.entries()) if (k.startsWith('config.') && v !== '') config[k.slice(7)] = v;
      if (config.port) config.port = Number(config.port);
      if (type === 'email') { if (config.to) config.to = config.to.split(',').map((x) => x.trim()).filter(Boolean); config.secure = Number(config.port) === 465; }
       
      if (c) for (const [k] of TYPES[type].fields) if (!(k in config) && c.config[k] !== undefined) config[k] = c.config[k];
      const body = { name: fd.get('name'), type, config, enabled: form.querySelector('[name=enabled]').checked, applyAll: form.querySelector('[name=applyAll]').checked, monitorIds: [...form.querySelectorAll('[name=m]:checked')].map((x) => Number(x.value)) };
      try { c ? await api.put(`/api/channels/${c.id}`, body) : await api.post('/api/channels', body); m.close(); toast('Channel saved', 'ok'); load(); }
      catch (e) { if (e instanceof ApiError && e.details) { const left = showFieldErrors(form, e.details); if (left.length) toast(left.map((k) => `${k}: ${e.details[k]}`).join('; '), 'err'); } else toast(e.message, 'err'); }
    }
  }
  await load();
}
