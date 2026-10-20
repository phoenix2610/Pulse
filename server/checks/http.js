import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

const MAX_BODY = 1024 * 1024;
const MAX_REDIRECTS = 5;

 
export function statusMatcher(spec = '200-399') {
  const parts = String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(p);
    if (!m) throw new Error(`Invalid status spec "${p}"`);
    return [Number(m[1]), Number(m[2] ?? m[1])];
  });
  return (code) => parts.some(([lo, hi]) => code >= lo && code <= hi);
}

 
export function jsonPath(obj, expr) {
  const tokens = String(expr).replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) ?? [];
  let cur = obj;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    const idx = /^\[(\d+)\]$/.exec(t);
    cur = idx ? cur[Number(idx[1])] : cur[t];
  }
  return cur;
}

function request(urlStr, cfg, timeoutMs, deadline) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const t0 = performance.now();
    const timings = { dns: null, connect: null, tls: null, ttfb: null, total: null };
    const headers = { 'user-agent': 'Pulse/1.0 (+uptime-monitor)', accept: '*/*', ...(cfg.headers ?? {}) };
    let body;
    if (cfg.body) {
      body = Buffer.from(cfg.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) headers['content-length'] = body.length;
    }
    const req = lib.request(url, {
      method: cfg.method || 'GET',
      headers,
      rejectUnauthorized: !cfg.ignoreTls,
      agent: false,
      servername: url.hostname && !/^[\d.:]+$/.test(url.hostname) ? url.hostname : undefined,
    });

    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`Timed out after ${timeoutMs}ms`), { code: 'PULSE_TIMEOUT' })), Math.max(1, deadline - performance.now()));
    req.on('socket', (socket) => {
      socket.once('lookup', () => { timings.dns = performance.now() - t0; });
      socket.once('connect', () => { timings.connect = performance.now() - t0; });
      socket.once('secureConnect', () => { timings.tls = performance.now() - t0; });
    });
    req.on('response', (res) => {
      timings.ttfb = performance.now() - t0;
      let cert = null;
      if (res.socket?.getPeerCertificate) {
        const c = res.socket.getPeerCertificate();
        if (c?.valid_to) cert = { validTo: Date.parse(c.valid_to), issuer: c.issuer?.O || c.issuer?.CN, subject: c.subject?.CN };
      }
      const chunks = []; let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size <= MAX_BODY) chunks.push(d);
        else if (size > MAX_BODY * 2) res.destroy();
      });
      const done = () => {
        clearTimeout(timer);
        timings.total = performance.now() - t0;
        resolve({ res, body: Buffer.concat(chunks).toString('utf8'), timings, cert, bytes: size });
      };
      res.on('end', done);
      res.on('close', done);
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

export async function checkHttp(cfg, { timeoutMs = 10000 } = {}) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  let url = cfg.url;
  let hops = 0;
  const accepted = statusMatcher(cfg.expectedStatus || '200-399');
  try {
    let r;
    for (;;) {
      r = await request(url, hops === 0 ? cfg : { ...cfg, method: 'GET', body: undefined }, timeoutMs, deadline);
      const code = r.res.statusCode;
      const loc = r.res.headers.location;
      if (cfg.followRedirects !== false && loc && code >= 300 && code < 400) {
        if (++hops > MAX_REDIRECTS) return fail('Too many redirects', r, started);
        url = new URL(loc, url).toString();
        continue;
      }
      break;
    }
    const code = r.res.statusCode;
    const latencyMs = Math.round(performance.now() - started);
    const meta = { timings: roundTimings(r.timings), bytes: r.bytes, redirects: hops, finalUrl: url !== cfg.url ? url : undefined, server: r.res.headers.server };
    const out = { ok: true, latencyMs, statusCode: code, certExpiresAt: r.cert?.validTo, meta: { ...meta, cert: r.cert ?? undefined } };

    if (!accepted(code)) return { ...out, ok: false, error: `Unexpected status ${code} (expected ${cfg.expectedStatus || '200-399'})` };
    if (cfg.keyword) {
      const has = r.body.includes(cfg.keyword);
      if (cfg.keywordMode === 'absent' ? has : !has) return { ...out, ok: false, error: cfg.keywordMode === 'absent' ? `Forbidden keyword "${cfg.keyword}" found` : `Keyword "${cfg.keyword}" not found` };
    }
    if (cfg.jsonPath) {
      let parsed;
      try { parsed = JSON.parse(r.body); } catch { return { ...out, ok: false, error: 'Response is not valid JSON' }; }
      const val = jsonPath(parsed, cfg.jsonPath);
      if (val === undefined) return { ...out, ok: false, error: `JSON path ${cfg.jsonPath} not found` };
      if (cfg.jsonExpected !== undefined && cfg.jsonExpected !== '' && String(val) !== String(cfg.jsonExpected)) {
        return { ...out, ok: false, error: `JSON ${cfg.jsonPath} = ${JSON.stringify(val)} (expected ${cfg.jsonExpected})` };
      }
    }
    if (cfg.maxLatencyMs && latencyMs > cfg.maxLatencyMs) return { ...out, ok: false, error: `Too slow: ${latencyMs}ms > ${cfg.maxLatencyMs}ms` };
    return out;
  } catch (e) {
    return { ok: false, latencyMs: Math.round(performance.now() - started), error: describeError(e, timeoutMs) };
  }
}

function fail(error, r, started) {
  return { ok: false, latencyMs: Math.round(performance.now() - started), statusCode: r.res.statusCode, error };
}
const roundTimings = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v == null ? null : Math.round(v)]));

export function describeError(e, timeoutMs) {
  const code = e.code || e.cause?.code;
  switch (code) {
    case 'PULSE_TIMEOUT': return `Timed out after ${timeoutMs}ms`;
    case 'ENOTFOUND': return `DNS lookup failed for ${e.hostname ?? 'host'}`;
    case 'ECONNREFUSED': return 'Connection refused';
    case 'ECONNRESET': return 'Connection reset by peer';
    case 'EHOSTUNREACH': return 'Host unreachable';
    case 'ENETUNREACH': return 'Network unreachable';
    case 'CERT_HAS_EXPIRED': return 'TLS certificate has expired';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT': case 'SELF_SIGNED_CERT_IN_CHAIN': return 'Self-signed TLS certificate';
    case 'ERR_TLS_CERT_ALTNAME_INVALID': return 'TLS certificate does not match hostname';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': return 'Unable to verify TLS certificate chain';
    default: return e.message || String(code || 'Unknown error');
  }
}
