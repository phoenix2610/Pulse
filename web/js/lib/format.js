export function duration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h && (sec || !m)) parts.push(`${sec}s`);
  return parts.slice(0, 2).join(' ');
}
export function ago(ts, now = Date.now()) {
  if (!ts) return 'never';
  const d = now - ts;
  if (d < 5000) return 'just now';
  if (d < 0) return 'in ' + duration(-d);
  return duration(d) + ' ago';
}
const dtf = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const tf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const df = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
export const dateTime = (ts) => (ts ? dtf.format(ts) : '—');
export const time = (ts) => tf.format(ts);
export const date = (ts) => df.format(ts);
export const fullDate = (ts) => (ts ? full.format(ts) : '—');
export const pct = (n, digits = 2) => (n == null ? '—' : `${Number(n.toFixed(digits))}%`);
export const ms = (n) => (n == null ? '—' : `${Math.round(n)} ms`);
export const STATUS_LABEL = { up: 'Up', down: 'Down', pending: 'Checking', paused: 'Paused', maintenance: 'Maintenance', operational: 'Operational', degraded: 'Degraded', outage: 'Outage', partial_outage: 'Partial outage' };
export const TYPE_LABEL = { http: 'HTTP(s)', tcp: 'TCP port', dns: 'DNS', tls: 'TLS certificate', ping: 'Ping (ICMP)', push: 'Heartbeat' };
export function target(m) {
  const c = m.config ?? {};
  if (m.type === 'push') return 'heartbeat';
  return c.url || (c.host ? `${c.host}${c.port ? ':' + c.port : ''}` : m.type);
}
export const initials = (name = '?') => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export function toLocalInput(ts) {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
export const fromLocalInput = (v) => new Date(v).getTime();
