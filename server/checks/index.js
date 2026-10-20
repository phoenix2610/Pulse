import { checkHttp } from './http.js';
import { checkTcp } from './tcp.js';
import { checkDns } from './dns.js';
import { checkTls } from './tls.js';
import { checkPing } from './ping.js';





export function checkPush(monitor, cfg) {
  const now = Date.now();
  const grace = (cfg.graceS ?? 30) * 1000;
  const limit = monitor.interval_s * 1000 + grace;
  const last = monitor.last_push_at;
  if (last && !monitor.last_push_ok && now - last < limit) return { ok: false, error: monitor.last_push_msg || 'Job reported failure' };
  if (!last) {
     
    if (now - monitor.created_at < limit) return { ok: true, latencyMs: null, meta: { waiting: true } };
    return { ok: false, error: 'No heartbeat ever received' };
  }
  if (now - last > limit) return { ok: false, error: `No heartbeat for ${Math.round((now - last) / 1000)}s (limit ${Math.round(limit / 1000)}s)` };
  return { ok: true, latencyMs: null, meta: { lastBeatAgoMs: now - last } };
}

export const CHECK_TYPES = ['http', 'tcp', 'dns', 'tls', 'ping', 'push'];

export async function runCheck(monitor, cfg = monitor.config) {
  const opts = { timeoutMs: monitor.timeout_ms ?? monitor.timeoutMs ?? 10000 };
  switch (monitor.type) {
    case 'http': return checkHttp(cfg, opts);
    case 'tcp': return checkTcp(cfg, opts);
    case 'dns': return checkDns(cfg, opts);
    case 'tls': return checkTls(cfg, opts);
    case 'ping': return checkPing(cfg, opts);
    case 'push': return checkPush(monitor, cfg);
    default: return { ok: false, error: `Unknown monitor type "${monitor.type}"` };
  }
}
