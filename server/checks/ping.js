import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.\-:]*[a-zA-Z0-9])?$/;

 
export async function checkPing(cfg, { timeoutMs = 10000 } = {}) {
  if (!HOST_RE.test(cfg.host)) return { ok: false, error: 'Invalid host' };
  const wait = Math.max(1, Math.ceil(timeoutMs / 1000));
  try {
    const { stdout } = await exec('ping', ['-n', '-c', String(cfg.count || 1), '-W', String(wait), '--', cfg.host], { timeout: timeoutMs + 2000 });
    const m = /(?:rtt|round-trip)[^=]*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(stdout) || /time[=<]([\d.]+)/.exec(stdout);
    const avg = m ? Number(m[2] ?? m[1]) : null;
    const loss = /(\d+(?:\.\d+)?)% packet loss/.exec(stdout);
    return { ok: true, latencyMs: avg == null ? null : Math.max(1, Math.round(avg)), meta: { lossPct: loss ? Number(loss[1]) : 0 } };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, error: '`ping` binary not installed on the server' };
    if (e.killed) return { ok: false, error: `Timed out after ${timeoutMs}ms` };
    const loss = /(\d+(?:\.\d+)?)% packet loss/.exec(e.stdout || '');
    return { ok: false, error: loss ? `${loss[1]}% packet loss` : (e.stderr || '').trim().split('\n')[0] || 'Host unreachable' };
  }
}
