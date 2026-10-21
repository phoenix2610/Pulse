import { z } from './schemas.js';
import { sendWebhook } from './webhook.js';
import { sendSlack, sendDiscord, sendTelegram, sendNtfy } from './chat.js';
import { sendEmail } from './email.js';
import { formatDuration } from '../util.js';

export const SENDERS = {
  webhook: sendWebhook, slack: sendSlack, discord: sendDiscord, telegram: sendTelegram, ntfy: sendNtfy, email: sendEmail,
};
export const CHANNEL_TYPES = Object.keys(SENDERS);
export { z as channelSchemas };

const ICON = { down: '🔴', up: '🟢', cert: '🟠', test: '🔔' };
const COLOR = { down: 0xe5484d, up: 0x30a46c, cert: 0xf5a524, test: 0x3e63dd };

 
export function buildEvent(kind, { monitor, incident, baseUrl = '', message } = {}) {
  const url = baseUrl ? `${baseUrl.replace(/\/$/, '')}/#/monitors/${monitor?.id ?? ''}` : null;
  const target = monitor ? describeTarget(monitor) : null;
  let title, text;
  switch (kind) {
    case 'down':
      title = `${monitor.name} is DOWN`;
      text = incident?.cause || monitor.last_error || 'Monitor failed its checks';
      break;
    case 'up':
      title = `${monitor.name} is back UP`;
      text = incident ? `Recovered after ${formatDuration((incident.resolved_at ?? Date.now()) - incident.started_at)}` : 'Recovered';
      break;
    case 'cert':
      title = `${monitor.name}: TLS certificate expiring`;
      text = message;
      break;
    default:
      title = 'Pulse test notification';
      text = message || 'If you can read this, the channel works.';
  }
  return {
    kind, icon: ICON[kind] ?? '•', color: COLOR[kind] ?? 0x888888, title, text, url, target,
    monitor: monitor && { id: monitor.id, name: monitor.name, type: monitor.type },
    incident: incident && { id: incident.id, startedAt: incident.started_at, resolvedAt: incident.resolved_at ?? null },
    timestamp: new Date().toISOString(),
  };
}

export function describeTarget(m) {
  const c = typeof m.config === 'string' ? JSON.parse(m.config || '{}') : (m.config ?? {});
  return c.url || (c.host ? `${c.host}${c.port ? ':' + c.port : ''}` : m.type);
}

 
export async function deliver(channel, event, { attempts = 3, backoffMs = 800, fetchImpl } = {}) {
  const send = SENDERS[channel.type];
  if (!send) return { ok: false, error: `Unknown channel type ${channel.type}` };
  const config = typeof channel.config === 'string' ? JSON.parse(channel.config) : channel.config;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await send(config, event, { fetchImpl });
      return { ok: true };
    } catch (e) {
      lastErr = e;
      if (e.permanent) break;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
    }
  }
  return { ok: false, error: lastErr?.message ?? 'Delivery failed' };
}
