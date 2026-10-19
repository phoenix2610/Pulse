import path from 'node:path';
import os from 'node:os';

const int = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

export function loadConfig(overrides = {}, env = process.env) {
  const dataDir = path.resolve(overrides.dataDir ?? env.PULSE_DATA ?? path.join(process.cwd(), 'data'));
  return {
    host: overrides.host ?? env.HOST ?? '127.0.0.1',
    port: overrides.port ?? int(env.PORT, 4400),
    dataDir,
    dbFile: overrides.dbFile ?? path.join(dataDir, 'pulse.db'),
    publicDir: overrides.publicDir ?? new URL('../web/', import.meta.url).pathname,
     
    cookieSecure: overrides.cookieSecure ?? bool(env.PULSE_COOKIE_SECURE, false),
    sessionTtlMs: overrides.sessionTtlMs ?? int(env.PULSE_SESSION_DAYS, 14) * 86400_000,
    concurrency: overrides.concurrency ?? int(env.PULSE_CONCURRENCY, Math.max(8, os.cpus().length * 4)),
    rawRetentionDays: overrides.rawRetentionDays ?? int(env.PULSE_RAW_RETENTION_DAYS, 14),
    rollupRetentionDays: overrides.rollupRetentionDays ?? int(env.PULSE_ROLLUP_RETENTION_DAYS, 400),
    schedulerEnabled: overrides.schedulerEnabled ?? true,
    baseUrl: overrides.baseUrl ?? env.PULSE_BASE_URL ?? '',
    trustProxy: overrides.trustProxy ?? bool(env.PULSE_TRUST_PROXY, false),
    notifyBackoffMs: overrides.notifyBackoffMs ?? int(env.PULSE_NOTIFY_BACKOFF_MS, 800),
    logLevel: overrides.logLevel ?? env.PULSE_LOG ?? 'info',
  };
}
