import { api } from './api.js';

 
class Store extends EventTarget {
  user = null;
  monitors = new Map();
  groups = [];
  summary = null;
  live = false;
  #es = null;
  #retry = 0;

  on(type, fn) {
    const h = (e) => fn(e.detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async loadMonitors() {
    const { monitors, groups } = await api.get('/api/monitors');
    this.monitors = new Map(monitors.map((m) => [m.id, m]));
    this.groups = groups;
    this.emit('monitors');
    return monitors;
  }
  async loadSummary() {
    this.summary = await api.get('/api/summary');
    this.emit('summary', this.summary);
    return this.summary;
  }

  connect() {
    if (this.#es) return;
    const es = new EventSource('/api/events');
    this.#es = es;
    es.addEventListener('hello', () => { this.live = true; this.#retry = 0; this.emit('live', true); });
    es.addEventListener('check', (e) => this.#onCheck(JSON.parse(e.data)));
    es.addEventListener('status', (e) => { this.emit('status', JSON.parse(e.data)); this.loadSummary().catch(() => {}); });
    es.addEventListener('incident', (e) => { this.emit('incident', JSON.parse(e.data)); this.loadSummary().catch(() => {}); });
    es.onerror = () => {
      this.live = false; this.emit('live', false);
       
      if (es.readyState === EventSource.CLOSED) { this.#es = null; setTimeout(() => this.user && this.connect(), Math.min(15000, 1000 * 2 ** this.#retry++)); }
    };
  }
  disconnect() { this.#es?.close(); this.#es = null; this.live = false; }

  #onCheck(c) {
    const m = this.monitors.get(c.monitorId);
    if (m) {
      m.status = c.status;
      m.lastCheckedAt = c.ts;
      m.lastLatencyMs = c.latencyMs;
      m.lastError = c.error;
      m.sparkline = [...(m.sparkline ?? []).slice(-89), { ts: c.ts, ok: c.ok, latencyMs: c.latencyMs, maintenance: c.maintenance }];
    }
    this.emit('check', c);
  }
}
export const store = new Store();
