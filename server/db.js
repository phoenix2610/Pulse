import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
    `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT,
    ip TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    read_only INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE monitors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    interval_s INTEGER NOT NULL DEFAULT 60,
    timeout_ms INTEGER NOT NULL DEFAULT 10000,
    retries INTEGER NOT NULL DEFAULT 2,
    enabled INTEGER NOT NULL DEFAULT 1,
    group_name TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    push_token TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_checked_at INTEGER,
    last_status_change_at INTEGER,
    last_latency_ms INTEGER,
    last_error TEXT,
    last_meta TEXT,
    last_push_at INTEGER,
    cert_expires_at INTEGER,
    cert_alerted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER,
    status_code INTEGER,
    error TEXT,
    maintenance INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX checks_monitor_ts ON checks(monitor_id, ts DESC);
  CREATE INDEX checks_ts ON checks(ts);
  CREATE TABLE rollups (
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    hour INTEGER NOT NULL,
    total INTEGER NOT NULL,
    up INTEGER NOT NULL,
    lat_sum INTEGER NOT NULL DEFAULT 0,
    lat_n INTEGER NOT NULL DEFAULT 0,
    lat_min INTEGER,
    lat_max INTEGER,
    PRIMARY KEY (monitor_id, hour)
  ) WITHOUT ROWID;
  CREATE TABLE incidents (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    resolved_at INTEGER,
    cause TEXT,
    ack_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ack_at INTEGER
  );
  CREATE INDEX incidents_monitor ON incidents(monitor_id, started_at DESC);
  CREATE INDEX incidents_open ON incidents(resolved_at);
  CREATE TABLE incident_events (
    id INTEGER PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    author TEXT,
    message TEXT
  );
  CREATE INDEX incident_events_incident ON incident_events(incident_id, ts);
  CREATE TABLE channels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    apply_all INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE monitor_channels (
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    PRIMARY KEY (monitor_id, channel_id)
  ) WITHOUT ROWID;
  CREATE TABLE notification_log (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    incident_id INTEGER REFERENCES incidents(id) ON DELETE SET NULL,
    event TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT
  );
  CREATE INDEX notification_log_ts ON notification_log(ts DESC);
  CREATE TABLE maintenance (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE maintenance_monitors (
    maintenance_id INTEGER NOT NULL REFERENCES maintenance(id) ON DELETE CASCADE,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    PRIMARY KEY (maintenance_id, monitor_id)
  ) WITHOUT ROWID;
  CREATE TABLE status_pages (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE status_page_monitors (
    page_id INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    label TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (page_id, monitor_id)
  ) WITHOUT ROWID;
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  `,
    `
  CREATE TABLE announcements (
    id INTEGER PRIMARY KEY,
    page_id INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT,
    level TEXT NOT NULL DEFAULT 'info',
    created_at INTEGER NOT NULL,
    expires_at INTEGER
  );
  CREATE INDEX announcements_page ON announcements(page_id, created_at DESC);
  `,
    `
  ALTER TABLE monitors ADD COLUMN last_push_ok INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE monitors ADD COLUMN last_push_msg TEXT;
  `,
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return MIGRATIONS.length;
}

 
export function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {   }
    throw e;
  }
}

 
export function stmtCache(db) {
  const cache = new Map();
  return (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
}

export const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');
