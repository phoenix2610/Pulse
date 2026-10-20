import dns from 'node:dns/promises';
import { performance } from 'node:perf_hooks';
import { describeError } from './http.js';

const flatten = (type, answers) => answers.map((a) => {
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return a.join('');
  if (type === 'MX') return `${a.priority} ${a.exchange}`;
  if (type === 'SOA') return `${a.nsname} ${a.hostmaster}`;
  return JSON.stringify(a);
});

export async function checkDns(cfg, { timeoutMs = 10000 } = {}) {
  const t0 = performance.now();
  const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
  if (cfg.nameserver) resolver.setServers([cfg.nameserver]);
  const type = (cfg.recordType || 'A').toUpperCase();
  try {
    const answers = flatten(type, await resolver.resolve(cfg.host, type));
    const latencyMs = Math.round(performance.now() - t0);
    const meta = { answers: answers.slice(0, 20) };
    if (!answers.length) return { ok: false, latencyMs, error: `No ${type} records`, meta };
    if (cfg.expected && !answers.some((a) => a.includes(cfg.expected))) {
      return { ok: false, latencyMs, error: `Expected "${cfg.expected}" not in ${type} answers: ${answers.slice(0, 3).join(', ')}`, meta };
    }
    return { ok: true, latencyMs, meta };
  } catch (e) {
    return { ok: false, latencyMs: Math.round(performance.now() - t0), error: e.code === 'ENODATA' ? `No ${type} records` : describeError(e, timeoutMs) };
  }
}
