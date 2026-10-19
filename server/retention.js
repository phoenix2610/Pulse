import { DAY } from './util.js';

 
export function createRetention({ models, config, log }) {
  let timer = null;

  function sweep(now = Date.now()) {
    const { checks, sessions, channels, incidents, db } = models;
    const r = {
      checks: checks.pruneRaw(now - config.rawRetentionDays * DAY),
      rollups: checks.pruneRollups(now - config.rollupRetentionDays * DAY),
      sessions: sessions.prune(),
      notifications: channels.pruneLog(now - 90 * DAY),
      incidents: incidents.prune(now - config.rollupRetentionDays * DAY),
    };
    if (r.checks > 10_000) { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {   } }
    if (Object.values(r).some(Boolean)) log.info('retention sweep', r);
    return r;
  }

  return {
    sweep,
    start() { timer = setInterval(sweep, 6 * 3600_000); timer.unref?.(); setTimeout(sweep, 30_000).unref?.(); },
    stop() { clearInterval(timer); },
  };
}
