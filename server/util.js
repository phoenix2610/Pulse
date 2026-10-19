import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg);

export const now = () => Date.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const HOUR = 3600_000;
export const DAY = 86400_000;
export const hourOf = (ts) => Math.floor(ts / HOUR) * HOUR;

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
export function verifyPassword(password, stored) {
  const [alg, n, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const dk = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: SCRYPT.r, p: SCRYPT.p,
  });
  return crypto.timingSafeEqual(dk, expected);
}

export const parseJson = (s, fallback = null) => {
  if (s === null || s === undefined || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

 
export function parseDuration(input) {
  if (typeof input === 'number') return input;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(String(input).trim());
  if (!m) return NaN;
  const mult = { ms: 1, s: 1000, m: 60_000, h: HOUR, d: DAY }[m[2] || 'ms'];
  return Math.round(Number(m[1]) * mult);
}

export function formatDuration(ms) {
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

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

export function createLogger(level = 'info') {
  const order = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
  const min = order[level] ?? 1;
  const emit = (lvl, args) => {
    if (order[lvl] < min) return;
    const ts = new Date().toISOString();
    (lvl === 'error' ? console.error : console.log)(`${ts} ${lvl.toUpperCase().padEnd(5)}`, ...args);
  };
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

 
export class Bus {
  #subs = new Set();
  subscribe(fn) { this.#subs.add(fn); return () => this.#subs.delete(fn); }
  emit(type, data) {
    const evt = { type, data, ts: Date.now() };
    for (const fn of this.#subs) { try { fn(evt); } catch {   } }
  }
  get size() { return this.#subs.size; }
}

 
export class Semaphore {
  #max; #active = 0; #queue = [];
  constructor(max) { this.#max = max; }
  get active() { return this.#active; }
  get waiting() { return this.#queue.length; }
  async run(fn) {
    if (this.#active >= this.#max) await new Promise((r) => this.#queue.push(r));
    this.#active++;
    try { return await fn(); } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }
}
