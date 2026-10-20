import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { describeError } from './http.js';

export function checkTcp(cfg, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    let banner = '';
    const socket = net.connect({ host: cfg.host, port: cfg.port });
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ latencyMs: Math.round(performance.now() - t0), ...r });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `Timed out after ${timeoutMs}ms` }), timeoutMs);
    socket.once('error', (e) => finish({ ok: false, error: describeError(e, timeoutMs) }));
    socket.once('connect', () => {
      if (!cfg.expectBanner && !cfg.send) return finish({ ok: true, meta: { connectMs: Math.round(performance.now() - t0) } });
      if (cfg.send) socket.write(cfg.send.replace(/\\r/g, '\r').replace(/\\n/g, '\n'));
    });
    socket.on('data', (d) => {
      banner += d.toString('utf8');
      if (cfg.expectBanner) {
        if (banner.includes(cfg.expectBanner)) finish({ ok: true, meta: { banner: banner.slice(0, 200) } });
        else if (banner.length > 4096) finish({ ok: false, error: `Banner did not contain "${cfg.expectBanner}"`, meta: { banner: banner.slice(0, 200) } });
      } else finish({ ok: true, meta: { banner: banner.slice(0, 200) } });
    });
    socket.once('close', () => finish({ ok: false, error: cfg.expectBanner ? `Closed before banner "${cfg.expectBanner}"` : 'Connection closed' }));
  });
}
