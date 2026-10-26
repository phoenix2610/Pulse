import { h, mount, icon } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { link, go } from '../lib/router.js';
import { toast, showFieldErrors, empty } from '../lib/ui.js';
import { TYPE_LABEL, ms } from '../lib/format.js';

const TYPES = ['http', 'tcp', 'dns', 'tls', 'ping', 'push'];
const TYPE_HELP = {
  http: 'Request a URL and verify status code, content or JSON.', tcp: 'Check that a port accepts connections (databases, SMTP, SSH…).',
  dns: 'Resolve a record and optionally assert its value.', tls: 'Alert before a TLS certificate expires.',
  ping: 'ICMP echo to a host (needs the `ping` binary).', push: 'Cron / job “dead man’s switch”: your job calls Pulse, not the other way round.',
};
const INTERVALS = [[10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [600, '10 minutes'], [1800, '30 minutes'], [3600, '1 hour'], [86400, '24 hours']];

const field = (label, input, hint) => h('label.field', label, input, hint ? h('span.hint', hint) : null);
const text = (name, value = '', extra = {}) => h('input', { name, value, type: 'text', autocomplete: 'off', spellcheck: 'false', ...extra });
const num = (name, value, extra = {}) => h('input', { name, value, type: 'number', ...extra });
const sel = (name, options, value) => h('select', { name }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
const check = (name, label, checked) => h('label.check', h('input', { type: 'checkbox', name, checked: !!checked }), label);

 
function headersEditor(initial = {}) {
  const rows = h('div');
  const addRow = (k = '', v = '') => {
    const row = h('div.kv', h('input', { placeholder: 'Header', value: k, 'data-k': '' }), h('input', { placeholder: 'Value', value: v, 'data-v': '' }),
      h('button.btn.ghost.icon', { type: 'button', onclick: () => row.remove() }, icon('x', 14)));
    rows.append(row);
  };
  Object.entries(initial).forEach(([k, v]) => addRow(k, v));
  const el = h('div', rows, h('button.btn.sm', { type: 'button', onclick: () => addRow() }, icon('plus', 13), 'Add header'));
  el.value = () => Object.fromEntries([...rows.children].map((r) => [r.querySelector('[data-k]').value.trim(), r.querySelector('[data-v]').value]).filter(([k]) => k));
  return el;
}

function typeFields(type, c = {}) {
  const grid = h('div.form-grid');
  const add = (...els) => grid.append(...els);
  const ctl = {};
  switch (type) {
    case 'http':
      ctl.headers = headersEditor(c.headers);
      add(h('div.full', field('URL', text('config.url', c.url ?? 'https://', { placeholder: 'https://example.com/health', required: true }))),
        field('Method', sel('config.method', ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((m) => [m, m]), c.method ?? 'GET')),
        field('Expected status', text('config.expectedStatus', c.expectedStatus ?? '200-399'), 'Ranges and lists: 200-299, 404'),
        field('Body must contain / not contain', text('config.keyword', c.keyword ?? ''), 'Optional keyword check on the response body'),
        field('Keyword mode', sel('config.keywordMode', [['contains', 'Must contain'], ['absent', 'Must NOT contain']], c.keywordMode ?? 'contains')),
        field('JSON path', text('config.jsonPath', c.jsonPath ?? '', { placeholder: 'data.status' }), 'Assert a value in a JSON response'),
        field('JSON expected value', text('config.jsonExpected', c.jsonExpected ?? '', { placeholder: 'ok' })),
        field('Max latency (ms)', num('config.maxLatencyMs', c.maxLatencyMs ?? '', { min: 1, placeholder: 'optional' }), 'Mark as failed when slower than this'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', justifyContent: 'center' } }, check('config.followRedirects', 'Follow redirects', c.followRedirects ?? true), check('config.ignoreTls', 'Ignore TLS errors', c.ignoreTls)),
      );
      grid.append(h('div.full', h('b', { style: { fontSize: '13px' } }, 'Request headers'), h('div', { style: { height: '6px' } }), ctl.headers),
        h('label.field.full', 'Request body', h('textarea', { name: 'config.body', placeholder: '{"ping": true}', rows: 3 }, c.body ?? '')));
      break;
    case 'tcp':
      add(field('Host', text('config.host', c.host ?? '', { required: true, placeholder: 'db.internal' })), field('Port', num('config.port', c.port ?? '', { required: true, min: 1, max: 65535 })),
        field('Send (optional)', text('config.send', c.send ?? '', { placeholder: 'PING\\r\\n' }), 'Written after connecting; \\r \\n are expanded'),
        field('Expect banner (optional)', text('config.expectBanner', c.expectBanner ?? '', { placeholder: 'SSH-2.0' })));
      break;
    case 'dns':
      add(field('Hostname', text('config.host', c.host ?? '', { required: true, placeholder: 'example.com' })),
        field('Record type', sel('config.recordType', ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA'].map((t) => [t, t]), c.recordType ?? 'A')),
        field('Expected value contains', text('config.expected', c.expected ?? '', { placeholder: 'optional' })), field('Nameserver (optional)', text('config.nameserver', c.nameserver ?? '', { placeholder: '1.1.1.1' })));
      break;
    case 'tls':
      add(field('Hostname', text('config.host', c.host ?? '', { required: true, placeholder: 'example.com' })), field('Port', num('config.port', c.port ?? 443, { min: 1, max: 65535 })),
        field('Alert when fewer than (days) remain', num('config.warnDays', c.warnDays ?? 14, { min: 1, max: 365 })), h('div', { style: { display: 'flex', alignItems: 'center' } }, check('config.ignoreTls', 'Allow untrusted chain', c.ignoreTls)));
      break;
    case 'ping':
      add(field('Host', text('config.host', c.host ?? '', { required: true, placeholder: '8.8.8.8' })), field('Packets', num('config.count', c.count ?? 1, { min: 1, max: 5 })));
      break;
    case 'push':
      add(field('Grace period (seconds)', num('config.graceS', c.graceS ?? 30, { min: 0 }), 'Extra time allowed after the interval before alerting'),
        h('div.banner.blue', 'You’ll get a unique heartbeat URL after saving.'));
      break;
  }
  return { el: grid, ctl };
}

export async function monitorFormView(root, { id }) {
  const editing = id != null;
  const [{ channels }, existing] = await Promise.all([api.get('/api/channels'), editing ? api.get(`/api/monitors/${id}`) : Promise.resolve(null)]);
  const m = existing ?? { name: '', type: 'http', config: {}, intervalS: 60, timeoutMs: 10000, retries: 2, enabled: true, group: '', tags: [], channelIds: channels.filter((c) => c.applyAll).map((c) => c.id) };
  let type = m.type;
  const cfgHolder = h('div');
  let ctl = {};
  const testOut = h('div');

  const drawFields = () => { const f = typeFields(type, type === m.type ? m.config : {}); ctl = f.ctl; mount(cfgHolder, f.el); };
  const typePicker = h('div.grid.cols-3', TYPES.map((t) => h('label.card.clickable', { style: { padding: '10px 12px', display: editing ? 'none' : '' }, class: 'card clickable' + (t === type ? ' sel' : '') },
    h('div.row', h('input', { type: 'radio', name: 'type', value: t, checked: t === type, onchange: () => { type = t; typePicker.querySelectorAll('label').forEach((l) => l.style.borderColor = ''); drawFields(); paint(); } }), h('b', TYPE_LABEL[t])),
    h('div.faint', { style: { fontSize: '12px', marginTop: '4px' } }, TYPE_HELP[t]))));
  const paint = () => typePicker.querySelectorAll('label').forEach((l) => { l.style.borderColor = l.querySelector('input').checked ? 'var(--accent)' : ''; });
  drawFields();

  const chBoxes = channels.map((c) => h('label.check', h('input', { type: 'checkbox', name: 'channel', value: c.id, checked: m.channelIds?.includes(c.id) || c.applyAll, disabled: c.applyAll }), c.name, h('span.tag', c.type), c.applyAll ? h('span.faint', 'applies to all') : null));

  const form = h('form.stack', { onsubmit: submit });
  const collect = () => {
    const fd = new FormData(form);
    const cfg = {};
    for (const [k, v] of fd.entries()) if (k.startsWith('config.')) cfg[k.slice(7)] = v;
    form.querySelectorAll('input[type=checkbox][name^="config."]').forEach((cb) => { cfg[cb.name.slice(7)] = cb.checked; });
    for (const k of ['port', 'count', 'graceS', 'warnDays', 'maxLatencyMs']) { if (k in cfg) cfg[k] = cfg[k] === '' ? undefined : Number(cfg[k]); }
    for (const k of Object.keys(cfg)) if (cfg[k] === '' || cfg[k] === undefined) delete cfg[k];
    if (ctl.headers) { const hd = ctl.headers.value(); if (Object.keys(hd).length) cfg.headers = hd; }
    return {
      name: fd.get('name'), type, config: cfg, intervalS: Number(fd.get('intervalS')), timeoutMs: Number(fd.get('timeoutS')) * 1000, retries: Number(fd.get('retries')),
      group: (fd.get('group') || '').trim() || null, tags: (fd.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean),
      enabled: form.querySelector('[name=enabled]').checked,
      channelIds: [...form.querySelectorAll('input[name=channel]:checked')].map((c) => Number(c.value)),
    };
  };

  async function submit(e) {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const saved = editing ? await api.put(`/api/monitors/${id}`, collect()) : await api.post('/api/monitors', collect());
      toast(editing ? 'Monitor updated' : 'Monitor created', 'ok');
      go(`/monitors/${saved.id}`);
    } catch (err) {
      btn.disabled = false;
      if (err instanceof ApiError && err.details) {
        const leftover = showFieldErrors(form, err.details);
        toast(leftover.length ? `${err.message}: ${leftover.map((k) => `${k} ${err.details[k]}`).join('; ')}` : 'Please fix the highlighted fields', 'err');
      } else toast(err.message, 'err');
    }
  }

  async function runTest(btn) {
    btn.disabled = true; testOut.replaceChildren(h('span.spinner'));
    try {
      const { result } = await api.post('/api/monitors/test', collect());
      testOut.replaceChildren(h('div', { class: 'banner' + (result.ok ? ' blue' : ' red'), style: result.ok ? { background: 'var(--green-soft)', color: 'var(--green)' } : {} },
        h('b', result.ok ? '✓ Passed' : '✗ Failed'), result.latencyMs != null ? ` · ${ms(result.latencyMs)}` : '', result.statusCode ? ` · HTTP ${result.statusCode}` : '', result.error ? ` — ${result.error}` : ''));
    } catch (err) {
      testOut.replaceChildren(h('div.banner.red', err.details ? Object.entries(err.details).map(([k, v]) => `${k} ${v}`).join('; ') : err.message));
      if (err.details) showFieldErrors(form, err.details);
    }
    btn.disabled = false;
  }

  mount(form,
    h('div.page-head', h('a.btn.ghost.icon', { href: link(editing ? `/monitors/${id}` : '/') }, icon('chevron', 16, { style: 'transform:rotate(180deg)' })), h('h1.grow', editing ? `Edit ${m.name}` : 'New monitor')),
    editing ? null : h('div.card.pad.stack', h('h2', 'What do you want to monitor?'), typePicker),
    h('div.card.pad.stack', h('h2', 'Details'),
      h('div.form-grid', field('Name', text('name', m.name, { required: true, placeholder: 'Production API' })), field('Group', text('group', m.group ?? '', { placeholder: 'e.g. Core, Public' }), 'Monitors with the same group are shown together'),
        field('Tags', text('tags', (m.tags ?? []).join(', '), { placeholder: 'prod, eu, critical' }), 'Comma separated')),
      cfgHolder, h('div', testOut), type !== 'push' ? h('div', h('button.btn', { type: 'button', onclick: (e) => runTest(e.currentTarget) }, icon('zap', 14), 'Test configuration')) : null),
    h('div.card.pad.stack', h('h2', 'Schedule & alerting'),
      h('div.form-grid',
        field(type === 'push' ? 'Expected every' : 'Check every', sel('intervalS', INTERVALS, m.intervalS)),
        field('Timeout (seconds)', num('timeoutS', m.timeoutMs / 1000, { min: 0.5, max: 60, step: 0.5 }), 'Must not exceed the interval'),
        field('Mark DOWN after N consecutive failures', num('retries', m.retries, { min: 1, max: 10 }), 'Retries run every ~15s so a single blip never pages you')),
      h('div.stack', { style: { gap: '8px' } }, h('b', { style: { fontSize: '13px' } }, 'Notify'), channels.length ? chBoxes : h('p.muted', 'No alert channels yet. ', h('a', { href: link('/channels') }, 'Create one →'))),
      check('enabled', 'Monitoring enabled', m.enabled)),
    h('div.row', { style: { justifyContent: 'flex-end' } }, h('a.btn', { href: link(editing ? `/monitors/${id}` : '/') }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, editing ? 'Save changes' : 'Create monitor')));
  form.style.maxWidth = '860px';
  paint();
  mount(root, form);
}
