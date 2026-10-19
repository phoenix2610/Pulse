import { DAY, HOUR, hourOf, percentile } from './util.js';

const RANGES = {
  '1h': { ms: HOUR, bucket: 60_000 },
  '24h': { ms: DAY, bucket: 5 * 60_000 },
  '7d': { ms: 7 * DAY, bucket: HOUR },
  '30d': { ms: 30 * DAY, bucket: 4 * HOUR },
  '90d': { ms: 90 * DAY, bucket: DAY },
};
export const RANGE_KEYS = Object.keys(RANGES);

export function createStats(models) {
  const { checks } = models;

   
  function uptime(monitorId, windowMs, now = Date.now()) {
    const rows = checks.rollupRange(monitorId, hourOf(now - windowMs), now);
    let total = 0, up = 0;
    for (const r of rows) { total += r.total; up += r.up; }
    return total ? Math.round((up / total) * 10000) / 100 : null;
  }

  function uptimeSummary(monitorId, now = Date.now()) {
    return { '24h': uptime(monitorId, DAY, now), '7d': uptime(monitorId, 7 * DAY, now), '30d': uptime(monitorId, 30 * DAY, now), '90d': uptime(monitorId, 90 * DAY, now) };
  }

   
  function dailyBars(monitorId, days = 90, now = Date.now()) {
    const startDay = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
    const rows = checks.rollupRange(monitorId, startDay, now);
    const bars = Array.from({ length: days }, (_, i) => ({ day: startDay + i * DAY, total: 0, up: 0 }));
    for (const r of rows) {
      const idx = Math.floor((r.hour - startDay) / DAY);
      if (idx >= 0 && idx < days) { bars[idx].total += r.total; bars[idx].up += r.up; }
    }
    return bars.map((b) => ({ day: b.day, uptime: b.total ? Math.round((b.up / b.total) * 10000) / 100 : null, checks: b.total }));
  }

  



  function series(monitorId, range = '24h', now = Date.now()) {
    const spec = RANGES[range] ?? RANGES['24h'];
    const from = now - spec.ms;
    const buckets = new Map();
    const add = (ts, { total, up, latSum, latN, latMin, latMax }) => {
      const key = Math.floor(ts / spec.bucket) * spec.bucket;
      const b = buckets.get(key) ?? { ts: key, total: 0, up: 0, latSum: 0, latN: 0, min: null, max: null };
      b.total += total; b.up += up; b.latSum += latSum; b.latN += latN;
      if (latMin != null) b.min = b.min == null ? latMin : Math.min(b.min, latMin);
      if (latMax != null) b.max = b.max == null ? latMax : Math.max(b.max, latMax);
      buckets.set(key, b);
    };
    let latencies = null;
    if (spec.ms <= DAY) {
      latencies = [];
      for (const c of checks.since(monitorId, from)) {
        if (c.maintenance) continue;
        const lat = c.ok && c.latency_ms != null ? c.latency_ms : null;
        if (lat != null) latencies.push(lat);
        add(c.ts, { total: 1, up: c.ok, latSum: lat ?? 0, latN: lat == null ? 0 : 1, latMin: lat, latMax: lat });
      }
    } else {
      for (const r of checks.rollupRange(monitorId, hourOf(from), now)) {
        add(r.hour, { total: r.total, up: r.up, latSum: r.lat_sum, latN: r.lat_n, latMin: r.lat_min, latMax: r.lat_max });
      }
    }
    const points = [...buckets.values()].sort((a, b) => a.ts - b.ts).map((b) => ({
      ts: b.ts, avg: b.latN ? Math.round(b.latSum / b.latN) : null, min: b.min, max: b.max,
      uptime: b.total ? Math.round((b.up / b.total) * 10000) / 100 : null, checks: b.total,
    }));
    const out = { range, from, to: now, bucketMs: spec.bucket, points };
    if (latencies) {
      latencies.sort((a, b) => a - b);
      out.percentiles = { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) };
    }
    const all = points.filter((p) => p.avg != null);
    out.avg = all.length ? Math.round(all.reduce((s, p) => s + p.avg * p.checks, 0) / all.reduce((s, p) => s + p.checks, 0)) : null;
    return out;
  }

   
  function incidentStats(monitorId, windowMs = 30 * DAY, now = Date.now()) {
    const { rows } = models.incidents.list({ monitorId, since: now - windowMs, limit: 500 });
    const resolved = rows.filter((r) => r.resolved_at);
    const downtime = rows.reduce((s, r) => s + ((r.resolved_at ?? now) - r.started_at), 0);
    return {
      count: rows.length,
      mttrMs: resolved.length ? Math.round(resolved.reduce((s, r) => s + (r.resolved_at - r.started_at), 0) / resolved.length) : null,
      downtimeMs: downtime,
    };
  }

  return { uptime, uptimeSummary, dailyBars, series, incidentStats };
}
