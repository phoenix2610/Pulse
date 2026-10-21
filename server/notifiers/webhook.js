import { hmac } from '../util.js';

export class DeliveryError extends Error {
  constructor(message, permanent = false) { super(message); this.permanent = permanent; }
}

 
export async function postJson(url, body, { headers = {}, method = 'POST', fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': 'Pulse/1.0', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw new DeliveryError(`HTTP ${res.status}${text ? `: ${text}` : ''}`, permanent);
  }
  return res;
}

export async function sendWebhook(cfg, event, { fetchImpl } = {}) {
  const body = JSON.stringify({ event: event.kind, title: event.title, message: event.text, target: event.target, url: event.url,
    monitor: event.monitor, incident: event.incident, timestamp: event.timestamp });
  const headers = { 'x-pulse-event': event.kind };
  if (cfg.secret) headers['x-pulse-signature'] = `sha256=${hmac(cfg.secret, body)}`;
  await postJson(cfg.url, body, { headers, method: cfg.method || 'POST', fetchImpl });
}
