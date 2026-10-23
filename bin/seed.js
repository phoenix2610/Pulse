import { hashPassword } from '../server/util.js';
import { HOUR, DAY } from '../server/util.js';
import { tx } from '../server/db.js';

 
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

const DEMO = [
  { name: 'Marketing site', type: 'http', config: { url: 'https://example.com', expectedStatus: '200-299' }, group: 'Public', base: 90, jitter: 40, flaky: 0.001 },
  { name: 'API gateway', type: 'http', config: { url: 'https://example.org/health', jsonPath: 'status', jsonExpected: 'ok' }, group: 'Public', base: 140, jitter: 70, flaky: 0.004 },
  { name: 'Checkout service', type: 'http', config: { url: 'https://example.net/checkout/ping' }, group: 'Core', base: 210, jitter: 120, flaky: 0.01 },
  { name: 'Postgres primary', type: 'tcp', config: { host: 'db.internal', port: 5432 }, group: 'Core', base: 4, jitter: 3, flaky: 0.0005 },
  { name: 'Redis cache', type: 'tcp', config: { host: 'cache.internal', port: 6379 }, group: 'Core', base: 2, jitter: 2, flaky: 0.0008 },
  { name: 'DNS: example.com', type: 'dns', config: { host: 'example.com', recordType: 'A' }, group: 'Infra', base: 25, jitter: 20, flaky: 0.0005 },
  { name: 'TLS cert: example.com', type: 'tls', config: { host: 'example.com', port: 443, warnDays: 14 }, group: 'Infra', base: 60, jitter: 20, flaky: 0 },
  { name: 'Nightly backup job', type: 'push', config: { graceS: 600 }, interval: 86400, group: 'Jobs', base: 0, jitter: 0, flaky: 0 },
];

 
export function seed(models, { days = 30 } = {}) {
  const { monitors, checks, incidents, pages, db } = models;
  const now = Date.now();
  const rand = rng(42);
  const summary = { monitors: 0, checks: 0, incidents: 0 };
  tx(db, () => {
    if (!models.users.count()) models.users.create({ email: 'demo@pulse.local', name: 'Demo', passHash: hashPassword('pulse-demo-1') });
    const ids = [];
    for (const d of DEMO) {
      const id = monitors.create({ name: d.name, type: d.type, config: d.config, intervalS: d.interval ?? 60, timeoutMs: 10000, retries: 2, group: d.group, tags: [d.type], enabled: false });
      ids.push(id);
      summary.monitors++;
      const step = d.type === 'push' ? DAY : 5 * 60_000;  
      let down = 0, downSince = 0;
      for (let ts = now - days * DAY; ts <= now; ts += step) {
        if (!down && rand() < d.flaky * 0.15) { down = 1 + Math.floor(rand() * 6); downSince = ts; }
        const ok = !down;
        const wave = Math.sin((ts % DAY) / DAY * Math.PI * 2 - 2) * d.jitter * 0.4;
        const lat = ok ? Math.max(1, Math.round(d.base + wave + rand() * d.jitter)) : null;
         
        if (ts > now - 2 * DAY) checks.insert(id, { ts, ok, latencyMs: lat, statusCode: ok ? 200 : 503, error: ok ? null : 'Unexpected status 503', maintenance: false });
        else rollup(models, id, ts, ok, lat);
        summary.checks++;
        if (down) {
          down--;
          if (!down) {
            const inc = incidents.open(id, 'Unexpected status 503 (expected 200-399)', downSince);
            incidents.addEvent(inc, 'notified', null, 'Alert sent to 1/1 channel(s)', downSince + 1000);
            if (ts < now - 3600_000) incidents.ack(inc, { id: 1, name: 'Demo' });
            incidents.resolve(inc, ts);
            summary.incidents++;
          }
        }
      }
      monitors.applyState(id, { status: d.type === 'push' ? 'up' : 'up', consecutiveFailures: 0, checkedAt: now, changedAt: now - 3 * DAY, latencyMs: Math.round(d.base + d.jitter / 2), meta: null });
    }
    const pageId = pages.create({ slug: 'demo', title: 'Acme Status', description: 'Live status of Acme services.', monitors: ids.slice(0, 6).map((monitorId) => ({ monitorId })) });
    void pageId;
     
  });
  return summary;
}

function rollup(models, id, ts, ok, lat) {
  const hour = Math.floor(ts / HOUR) * HOUR;
  models.run(`INSERT INTO rollups(monitor_id,hour,total,up,lat_sum,lat_n,lat_min,lat_max) VALUES (?,?,1,?,?,?,?,?)
    ON CONFLICT(monitor_id,hour) DO UPDATE SET total=total+1, up=up+excluded.up, lat_sum=lat_sum+excluded.lat_sum, lat_n=lat_n+excluded.lat_n,
    lat_min=CASE WHEN excluded.lat_min IS NULL THEN lat_min WHEN lat_min IS NULL THEN excluded.lat_min ELSE MIN(lat_min, excluded.lat_min) END,
    lat_max=CASE WHEN excluded.lat_max IS NULL THEN lat_max WHEN lat_max IS NULL THEN excluded.lat_max ELSE MAX(lat_max, excluded.lat_max) END`,
    id, hour, ok ? 1 : 0, lat ?? 0, lat == null ? 0 : 1, lat, lat);
}
