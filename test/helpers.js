import http from 'node:http';
import { createApp } from '../server/app.js';

export async function makeApp(overrides = {}, deps = {}) {
  const app = createApp({ dbFile: ':memory:', port: 0, schedulerEnabled: false, logLevel: 'silent', logger: silent, ...overrides }, deps);
  await app.start();
  const base = `http://127.0.0.1:${app.config.port}`;
  const client = new Client(base);
  return { app, base, client, stop: () => app.stop() };
}
const silent = { debug() {}, info() {}, warn() {}, error() {} };

 
export class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.token = null; }
  async req(method, path, body, headers = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] ??= 'application/json';
    if (this.cookie) h.cookie = this.cookie;
    if (this.token) h.authorization = `Bearer ${this.token}`;
    const res = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }
  async setup(email = 'admin@test.dev', password = 'correct-horse-1') {
    const r = await this.post('/api/setup', { email, name: 'Admin', password });
    if (r.status !== 201) throw new Error(`setup failed: ${r.status} ${r.text}`);
    return r;
  }
}

 
export async function targetServer(handler) {
  const state = { handler: handler ?? ((req, res) => { res.end('ok'); }), hits: 0 };
  const server = http.createServer((req, res) => { state.hits++; state.handler(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, url: `http://127.0.0.1:${port}`, state, server, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}
