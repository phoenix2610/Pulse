import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { HttpError } from './util.js';

const MAX_JSON = 1024 * 1024;

export class Router {
  #routes = [];
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }).replace(/\/\*$/, '/(.*)') + '/?$');
    this.#routes.push({ method, re, keys, handlers, pattern });
    return this;
  }
  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  patch(p, ...h) { return this.add('PATCH', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.#routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return { route: null, pathMatched };
  }
}

 
export async function runHandlers(handlers, ctx) {
  let i = 0;
  const next = async () => {
    const h = handlers[i++];
    if (!h) return undefined;
    return h(ctx, next);
  };
  return next();
}

export async function readBody(req, limit = MAX_JSON) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function parseBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return undefined;
  const raw = await readBody(req);
  if (!raw.length) return {};
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body'); }
  }
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  return { _raw: raw.toString('utf8') };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAgeS, secure, httpOnly = true, sameSite = 'Strict', path: p = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${p}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAgeS !== undefined) c += `; Max-Age=${maxAgeS}`;
  return c;
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...headers });
  res.end(body);
}

 
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/;

export function createStaticServer(root) {
  const cache = new Map();  

  function load(file) {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit;
    const body = fs.readFileSync(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const entry = {
      mtimeMs: st.mtimeMs, body, type,
      etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`,
      gz: COMPRESSIBLE.test(type) && body.length > 512 ? zlib.gzipSync(body, { level: 9 }) : null,
    };
    cache.set(file, entry);
    return entry;
  }

   
  return function serve(req, res, pathname, { fallback = 'index.html' } = {}) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return false; }
    if (rel.includes('\0')) return false;
    let file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) return false;  
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      if (path.extname(rel)) return false;
      file = path.join(root, fallback);
    }
    let entry;
    try { entry = load(file); } catch { return false; }
    const headers = { 'content-type': entry.type, etag: entry.etag, vary: 'accept-encoding',
      'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=300, must-revalidate' };
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); res.end(); return true; }
    const useGz = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = useGz ? entry.gz : entry.body;
    if (useGz) headers['content-encoding'] = 'gzip';
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}

 
export function openSse(req, res, { retryMs = 3000, heartbeatMs = 20000 } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive', 'x-accel-buffering': 'no',
  });
  res.write(`retry: ${retryMs}\n\n`);
  const hb = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
  const close = () => clearInterval(hb);
  req.on('close', close);
  return {
    send(type, data, id) {
      res.write(`${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close: () => { close(); res.end(); },
  };
}

 
export class RateLimiter {
  #hits = new Map();
  constructor({ max, windowMs }) {
    this.max = max; this.windowMs = windowMs;
    setInterval(() => this.#gc(), windowMs).unref?.();
  }
  #gc() { const t = Date.now(); for (const [k, v] of this.#hits) if (v.reset < t) this.#hits.delete(k); }
   
  hit(key) {
    const t = Date.now();
    let e = this.#hits.get(key);
    if (!e || e.reset < t) { e = { n: 0, reset: t + this.windowMs }; this.#hits.set(key, e); }
    e.n++;
    return { ok: e.n <= this.max, remaining: Math.max(0, this.max - e.n), retryAfterS: Math.ceil((e.reset - t) / 1000) };
  }
  clear(key) { this.#hits.delete(key); }
}
