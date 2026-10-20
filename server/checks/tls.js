import tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import { describeError } from './http.js';
import { DAY } from '../util.js';

 
export function checkTls(cfg, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let done = false;
    const socket = tls.connect({
      host: cfg.host, port: cfg.port || 443, servername: cfg.host, rejectUnauthorized: !cfg.ignoreTls,
    });
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ latencyMs: Math.round(performance.now() - t0), ...r });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `Timed out after ${timeoutMs}ms` }), timeoutMs);
    socket.once('error', (e) => finish({ ok: false, error: describeError(e, timeoutMs) }));
    socket.once('secureConnect', () => {
      const c = socket.getPeerCertificate();
      if (!c?.valid_to) return finish({ ok: false, error: 'No certificate presented' });
      const validTo = Date.parse(c.valid_to);
      const daysLeft = Math.floor((validTo - Date.now()) / DAY);
      const warnDays = cfg.warnDays ?? 14;
      const meta = { cert: { validTo, issuer: c.issuer?.O || c.issuer?.CN, subject: c.subject?.CN, daysLeft }, protocol: socket.getProtocol() };
      if (daysLeft < 0) return finish({ ok: false, error: `Certificate expired ${-daysLeft}d ago`, certExpiresAt: validTo, meta });
      if (daysLeft < warnDays) return finish({ ok: false, error: `Certificate expires in ${daysLeft}d (threshold ${warnDays}d)`, certExpiresAt: validTo, meta });
      finish({ ok: true, certExpiresAt: validTo, meta });
    });
  });
}
