import { Semaphore, clamp } from './util.js';





export class Scheduler {
  constructor({ models, execute, concurrency = 16, log, retryDelayMs = 15_000 }) {
    this.models = models;
    this.execute = execute;
    this.log = log;
    this.gate = new Semaphore(concurrency);
    this.retryDelayMs = retryDelayMs;
    this.timers = new Map();
    this.inflight = new Set();
    this.running = false;
  }

  start() {
    this.running = true;
    const rows = this.models.monitors.enabledRows();
    for (const m of rows) {
      const due = m.last_checked_at ? m.last_checked_at + m.interval_s * 1000 - Date.now() : 0;
       
      this.#arm(m.id, clamp(due, 0, m.interval_s * 1000) + Math.random() * Math.min(5000, m.interval_s * 250));
    }
    this.log.info(`scheduler started with ${rows.length} monitor(s)`);
  }

  stop() {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

   
  reschedule(id, delayMs = 250) {
    this.cancel(id);
    if (!this.running) return;
    const m = this.models.monitors.row(id);
    if (m?.enabled) this.#arm(id, delayMs);
  }

  cancel(id) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

   
  runNow(id) {
    return this.gate.run(() => this.execute(id));
  }

  get stats() {
    return { scheduled: this.timers.size, active: this.gate.active, queued: this.gate.waiting };
  }

  #arm(id, delay) {
    const t = setTimeout(() => this.#tick(id), Math.max(0, delay));
    t.unref?.();
    this.timers.set(id, t);
  }

  async #tick(id) {
    this.timers.delete(id);
    if (!this.running || this.inflight.has(id)) return;
    this.inflight.add(id);
    try {
      await this.gate.run(() => this.execute(id));
    } catch (e) {
      this.log.error(`check #${id} crashed:`, e);
    } finally {
      this.inflight.delete(id);
    }
    if (!this.running) return;
    const m = this.models.monitors.row(id);
    if (!m || !m.enabled) return;
    const interval = m.interval_s * 1000;
    const next = m.status === 'pending' ? Math.min(interval, this.retryDelayMs) : interval;
    this.#arm(id, next + Math.random() * 300);
  }
}
