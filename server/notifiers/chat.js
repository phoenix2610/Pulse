import { postJson, DeliveryError } from './webhook.js';

export async function sendSlack(cfg, ev, { fetchImpl } = {}) {
  const fields = [];
  if (ev.target) fields.push({ type: 'mrkdwn', text: `*Target*\n${ev.target}` });
  if (ev.monitor) fields.push({ type: 'mrkdwn', text: `*Type*\n${ev.monitor.type}` });
  await postJson(cfg.webhookUrl, {
    text: `${ev.icon} ${ev.title}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${ev.icon} ${ev.title}`.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: ev.text ?? ' ' }, ...(fields.length ? { fields } : {}) },
      ...(ev.url ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Pulse' }, url: ev.url }] }] : []),
    ],
  }, { fetchImpl });
}

export async function sendDiscord(cfg, ev, { fetchImpl } = {}) {
  await postJson(cfg.webhookUrl, {
    content: ev.kind === 'down' && cfg.mention ? cfg.mention : undefined,
    embeds: [{
      title: `${ev.icon} ${ev.title}`.slice(0, 256), description: (ev.text ?? '').slice(0, 2000), color: ev.color, url: ev.url || undefined,
      fields: ev.target ? [{ name: 'Target', value: ev.target.slice(0, 1000), inline: true }] : [], timestamp: ev.timestamp,
      footer: { text: 'Pulse' },
    }],
  }, { fetchImpl });
}

export async function sendTelegram(cfg, ev, { fetchImpl } = {}) {
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await postJson(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    chat_id: cfg.chatId, parse_mode: 'HTML', disable_web_page_preview: true,
    text: `${ev.icon} <b>${esc(ev.title)}</b>\n${esc(ev.text)}${ev.target ? `\n<code>${esc(ev.target)}</code>` : ''}`,
  }, { fetchImpl });
}

export async function sendNtfy(cfg, ev, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${(cfg.server || 'https://ntfy.sh').replace(/\/$/, '')}/${cfg.topic}`, {
    method: 'POST',
    headers: {
      Title: ev.title.replace(/[^\x20-\x7e]/g, ''),  
      Priority: ev.kind === 'down' ? '5' : ev.kind === 'cert' ? '4' : '3',
      Tags: ev.kind === 'down' ? 'rotating_light' : ev.kind === 'up' ? 'white_check_mark' : 'bell',
      ...(ev.url ? { Click: ev.url } : {}),
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    },
    body: ev.text ?? '',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new DeliveryError(`ntfy HTTP ${res.status}`, res.status >= 400 && res.status < 500);
}
