import { tx, stmtCache, placeholders } from './db.js';
import { parseJson, randomToken, sha256, hourOf, HOUR, DAY, notFound } from './util.js';





export function createModels(db) {
  const q = stmtCache(db);
  const get = (sql, ...a) => q(sql).get(...a);
  const all = (sql, ...a) => q(sql).all(...a);
  const run = (sql, ...a) => q(sql).run(...a);
  const bool = (v) => (v ? 1 : 0);

   
  const users = {
    count: () => get('SELECT COUNT(*) n FROM users').n,
    create: ({ email, name, passHash }) =>
      Number(run('INSERT INTO users(email,name,pass_hash,created_at) VALUES (?,?,?,?)', email, name, passHash, Date.now()).lastInsertRowid),
    byEmail: (email) => get('SELECT * FROM users WHERE email = ?', email),
    byId: (id) => get('SELECT * FROM users WHERE id = ?', id),
    setPassword: (id, passHash) => run('UPDATE users SET pass_hash = ? WHERE id = ?', passHash, id),
    setName: (id, name) => run('UPDATE users SET name = ? WHERE id = ?', name, id),
    out: (u) => u && { id: u.id, email: u.email, name: u.name, createdAt: u.created_at },
  };

  const sessions = {
    create(userId, ttlMs, { userAgent, ip } = {}) {
      const token = randomToken(32);
      const t = Date.now();
      run('INSERT INTO sessions(id,user_id,created_at,expires_at,user_agent,ip) VALUES (?,?,?,?,?,?)',
        sha256(token), userId, t, t + ttlMs, userAgent?.slice(0, 200) ?? null, ip ?? null);
      return token;
    },
    byToken: (token) => get(
      'SELECT s.*, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?',
      sha256(token), Date.now()),
    destroy: (token) => run('DELETE FROM sessions WHERE id = ?', sha256(token)),
    destroyAllFor: (userId, exceptToken) =>
      run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, exceptToken ? sha256(exceptToken) : ''),
    list: (userId) => all('SELECT id, created_at, expires_at, user_agent, ip FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC', userId, Date.now()),
    prune: () => run('DELETE FROM sessions WHERE expires_at < ?', Date.now()).changes,
  };

  const tokens = {
    create(userId, name, readOnly = false) {
      const secret = 'pls_' + randomToken(24);
      const id = Number(run('INSERT INTO api_tokens(user_id,name,prefix,hash,read_only,created_at) VALUES (?,?,?,?,?,?)',
        userId, name, secret.slice(0, 8), sha256(secret), bool(readOnly), Date.now()).lastInsertRowid);
      return { id, secret };
    },
    byToken: (secret) => get('SELECT t.*, u.email, u.name FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ?', sha256(secret)),
    touch: (id) => run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', Date.now(), id),
    list: (userId) => all('SELECT id, name, prefix, read_only, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC', userId)
      .map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, readOnly: !!t.read_only, createdAt: t.created_at, lastUsedAt: t.last_used_at })),
    remove: (userId, id) => run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', id, userId).changes > 0,
  };

   
  const monitors = {
    row: (id) => get('SELECT * FROM monitors WHERE id = ?', id),
    byPushToken: (token) => get('SELECT * FROM monitors WHERE push_token = ? AND type = ?', token, 'push'),
    listRows: () => all('SELECT * FROM monitors ORDER BY name COLLATE NOCASE'),
    enabledRows: () => all('SELECT * FROM monitors WHERE enabled = 1'),
    create(m) {
      const t = Date.now();
      return tx(db, () => {
        const id = Number(run(
          `INSERT INTO monitors(name,type,config,interval_s,timeout_ms,retries,enabled,group_name,tags,push_token,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          m.name, m.type, JSON.stringify(m.config ?? {}), m.intervalS, m.timeoutMs, m.retries, bool(m.enabled ?? true),
          m.group ?? null, JSON.stringify(m.tags ?? []), m.type === 'push' ? randomToken(18) : null,
          m.enabled === false ? 'paused' : 'pending', t, t).lastInsertRowid);
        if (m.channelIds) monitors.setChannels(id, m.channelIds);
        return id;
      });
    },
    update(id, m) {
      return tx(db, () => {
        const cur = monitors.row(id);
        if (!cur) throw notFound('Monitor');
        const enabled = m.enabled ?? !!cur.enabled;
        const status = !enabled ? 'paused' : cur.status === 'paused' ? 'pending' : cur.status;
        run(`UPDATE monitors SET name=?, type=?, config=?, interval_s=?, timeout_ms=?, retries=?, enabled=?, group_name=?, tags=?, status=?, updated_at=?,
             push_token = CASE WHEN ? = 'push' THEN COALESCE(push_token, ?) ELSE NULL END WHERE id=?`,
          m.name ?? cur.name, m.type ?? cur.type, JSON.stringify(m.config ?? parseJson(cur.config, {})),
          m.intervalS ?? cur.interval_s, m.timeoutMs ?? cur.timeout_ms, m.retries ?? cur.retries, bool(enabled),
          m.group !== undefined ? m.group : cur.group_name, JSON.stringify(m.tags ?? parseJson(cur.tags, [])),
          status, Date.now(), m.type ?? cur.type, randomToken(18), id);
        if (m.channelIds) monitors.setChannels(id, m.channelIds);
      });
    },
    remove: (id) => run('DELETE FROM monitors WHERE id = ?', id).changes > 0,
    setEnabled(id, enabled) {
      const cur = monitors.row(id);
      run('UPDATE monitors SET enabled = ?, status = ?, consecutive_failures = 0, last_status_change_at = ?, updated_at = ? WHERE id = ?',
        bool(enabled), enabled ? 'pending' : 'paused', Date.now(), Date.now(), id);
      return cur;
    },
    setChannels(id, channelIds) {
      run('DELETE FROM monitor_channels WHERE monitor_id = ?', id);
      for (const cid of new Set(channelIds)) run('INSERT OR IGNORE INTO monitor_channels(monitor_id, channel_id) VALUES (?,?)', id, cid);
    },
    channelIds: (id) => all('SELECT channel_id FROM monitor_channels WHERE monitor_id = ?', id).map((r) => r.channel_id),
    applyState(id, s) {
      run(`UPDATE monitors SET status=?, consecutive_failures=?, last_checked_at=?, last_status_change_at=COALESCE(?, last_status_change_at),
           last_latency_ms=?, last_error=?, last_meta=?, cert_expires_at=COALESCE(?, cert_expires_at) WHERE id=?`,
        s.status, s.consecutiveFailures, s.checkedAt, s.changedAt ?? null, s.latencyMs ?? null, s.error ?? null,
        s.meta ? JSON.stringify(s.meta) : null, s.certExpiresAt ?? null, id);
    },
    markPush: (id, ts, ok = true, msg = null) => run('UPDATE monitors SET last_push_at = ?, last_push_ok = ?, last_push_msg = ? WHERE id = ?', ts, bool(ok), msg, id),
    markCertAlerted: (id, ts) => run('UPDATE monitors SET cert_alerted_at = ? WHERE id = ?', ts, id),
    groups: () => all("SELECT DISTINCT group_name g FROM monitors WHERE group_name IS NOT NULL AND group_name != '' ORDER BY 1").map((r) => r.g),
    out(r, extra = {}) {
      if (!r) return r;
      return {
        id: r.id, name: r.name, type: r.type, config: parseJson(r.config, {}), intervalS: r.interval_s, timeoutMs: r.timeout_ms,
        retries: r.retries, enabled: !!r.enabled, group: r.group_name, tags: parseJson(r.tags, []),
        pushToken: r.type === 'push' ? r.push_token : undefined,
        status: r.status, consecutiveFailures: r.consecutive_failures, lastCheckedAt: r.last_checked_at,
        lastStatusChangeAt: r.last_status_change_at, lastLatencyMs: r.last_latency_ms, lastError: r.last_error,
        lastMeta: parseJson(r.last_meta), certExpiresAt: r.cert_expires_at, createdAt: r.created_at, updatedAt: r.updated_at,
        ...extra,
      };
    },
  };

   
  const checks = {
    insert(monitorId, c) {
      run('INSERT INTO checks(monitor_id,ts,ok,latency_ms,status_code,error,maintenance) VALUES (?,?,?,?,?,?,?)',
        monitorId, c.ts, bool(c.ok), c.latencyMs ?? null, c.statusCode ?? null, c.error ?? null, bool(c.maintenance));
      if (c.maintenance) return;
      const lat = c.ok && c.latencyMs != null ? c.latencyMs : null;
      run(`INSERT INTO rollups(monitor_id,hour,total,up,lat_sum,lat_n,lat_min,lat_max) VALUES (?,?,1,?,?,?,?,?)
           ON CONFLICT(monitor_id,hour) DO UPDATE SET total=total+1, up=up+excluded.up, lat_sum=lat_sum+excluded.lat_sum,
             lat_n=lat_n+excluded.lat_n, lat_min=CASE WHEN excluded.lat_min IS NULL THEN lat_min WHEN lat_min IS NULL THEN excluded.lat_min ELSE MIN(lat_min, excluded.lat_min) END,
             lat_max=CASE WHEN excluded.lat_max IS NULL THEN lat_max WHEN lat_max IS NULL THEN excluded.lat_max ELSE MAX(lat_max, excluded.lat_max) END`,
        monitorId, hourOf(c.ts), bool(c.ok), lat ?? 0, lat == null ? 0 : 1, lat, lat);
    },
    recent: (monitorId, limit = 50, before = Infinity) => all(
      'SELECT id, ts, ok, latency_ms, status_code, error, maintenance FROM checks WHERE monitor_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?',
      monitorId, Number.isFinite(before) ? before : 9e15, limit).map(checks.out),
    since: (monitorId, since) => all(
      'SELECT ts, ok, latency_ms, maintenance FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY ts', monitorId, since),
    sparkline: (monitorId, n = 40) => all(
      'SELECT ts, ok, latency_ms, maintenance FROM checks WHERE monitor_id = ? ORDER BY ts DESC LIMIT ?', monitorId, n).reverse()
      .map((c) => ({ ts: c.ts, ok: !!c.ok, latencyMs: c.latency_ms, maintenance: !!c.maintenance })),
    rollupRange: (monitorId, from, to) => all(
      'SELECT hour, total, up, lat_sum, lat_n, lat_min, lat_max FROM rollups WHERE monitor_id = ? AND hour >= ? AND hour <= ? ORDER BY hour', monitorId, from, to),
    pruneRaw: (olderThan) => run('DELETE FROM checks WHERE ts < ?', olderThan).changes,
    pruneRollups: (olderThan) => run('DELETE FROM rollups WHERE hour < ?', olderThan).changes,
    out: (c) => ({ id: c.id, ts: c.ts, ok: !!c.ok, latencyMs: c.latency_ms, statusCode: c.status_code, error: c.error, maintenance: !!c.maintenance }),
  };

   
  const incidents = {
    open(monitorId, cause, ts = Date.now()) {
      return tx(db, () => {
        const id = Number(run('INSERT INTO incidents(monitor_id,started_at,cause) VALUES (?,?,?)', monitorId, ts, cause ?? null).lastInsertRowid);
        incidents.addEvent(id, 'opened', null, cause ?? 'Monitor went down', ts);
        return id;
      });
    },
    openFor: (monitorId) => get('SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1', monitorId),
    resolve(id, ts = Date.now()) {
      run('UPDATE incidents SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL', ts, id);
      incidents.addEvent(id, 'resolved', null, 'Monitor recovered', ts);
    },
    ack(id, user) {
      const inc = get('SELECT * FROM incidents WHERE id = ?', id);
      if (!inc) throw notFound('Incident');
      if (inc.ack_at) return false;
      run('UPDATE incidents SET ack_by = ?, ack_at = ? WHERE id = ?', user.id, Date.now(), id);
      incidents.addEvent(id, 'ack', user.name, 'Acknowledged');
      return true;
    },
    addEvent: (incidentId, kind, author, message, ts = Date.now()) =>
      Number(run('INSERT INTO incident_events(incident_id,ts,kind,author,message) VALUES (?,?,?,?,?)', incidentId, ts, kind, author ?? null, message ?? null).lastInsertRowid),
    events: (id) => all('SELECT id, ts, kind, author, message FROM incident_events WHERE incident_id = ? ORDER BY ts, id', id),
    row: (id) => get(
      `SELECT i.*, m.name monitor_name, m.type monitor_type, u.name ack_name FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id LEFT JOIN users u ON u.id = i.ack_by WHERE i.id = ?`, id),
    list({ status, monitorId, limit = 50, offset = 0, since } = {}) {
      const where = [], args = [];
      if (status === 'open') where.push('i.resolved_at IS NULL');
      if (status === 'resolved') where.push('i.resolved_at IS NOT NULL');
      if (monitorId) { where.push('i.monitor_id = ?'); args.push(monitorId); }
      if (since) { where.push('i.started_at >= ?'); args.push(since); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = get(`SELECT COUNT(*) n FROM incidents i ${w}`, ...args).n;
      const rows = all(
        `SELECT i.*, m.name monitor_name, m.type monitor_type, u.name ack_name FROM incidents i
         JOIN monitors m ON m.id = i.monitor_id LEFT JOIN users u ON u.id = i.ack_by ${w}
         ORDER BY i.started_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
      return { total, rows };
    },
    countOpen: () => get('SELECT COUNT(*) n FROM incidents WHERE resolved_at IS NULL').n,
    out: (r) => r && ({
      id: r.id, monitorId: r.monitor_id, monitorName: r.monitor_name, monitorType: r.monitor_type,
      startedAt: r.started_at, resolvedAt: r.resolved_at, cause: r.cause, ackAt: r.ack_at, ackBy: r.ack_name ?? null,
      durationMs: (r.resolved_at ?? Date.now()) - r.started_at, open: r.resolved_at == null,
    }),
    prune: (olderThan) => run('DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?', olderThan).changes,
  };

   
  const channels = {
    row: (id) => get('SELECT * FROM channels WHERE id = ?', id),
    listRows: () => all('SELECT * FROM channels ORDER BY name COLLATE NOCASE'),
    forMonitor: (monitorId) => all(
      `SELECT * FROM channels WHERE enabled = 1 AND (apply_all = 1 OR id IN (SELECT channel_id FROM monitor_channels WHERE monitor_id = ?))`, monitorId),
    create: (c) => Number(run('INSERT INTO channels(name,type,config,enabled,apply_all,created_at) VALUES (?,?,?,?,?,?)',
      c.name, c.type, JSON.stringify(c.config ?? {}), bool(c.enabled ?? true), bool(c.applyAll), Date.now()).lastInsertRowid),
    update(id, c) {
      const cur = channels.row(id);
      if (!cur) throw notFound('Channel');
      run('UPDATE channels SET name=?, type=?, config=?, enabled=?, apply_all=? WHERE id=?',
        c.name ?? cur.name, c.type ?? cur.type, JSON.stringify(c.config ?? parseJson(cur.config, {})),
        bool(c.enabled ?? !!cur.enabled), bool(c.applyAll ?? !!cur.apply_all), id);
    },
    remove: (id) => run('DELETE FROM channels WHERE id = ?', id).changes > 0,
    log: (channelId, incidentId, event, ok, error) =>
      run('INSERT INTO notification_log(ts,channel_id,incident_id,event,ok,error) VALUES (?,?,?,?,?,?)', Date.now(), channelId, incidentId ?? null, event, bool(ok), error?.slice(0, 500) ?? null),
    recentLog: (limit = 50) => all(
      `SELECT l.*, c.name channel_name, c.type channel_type FROM notification_log l LEFT JOIN channels c ON c.id = l.channel_id ORDER BY l.ts DESC LIMIT ?`, limit)
      .map((l) => ({ id: l.id, ts: l.ts, channelId: l.channel_id, channelName: l.channel_name, channelType: l.channel_type, incidentId: l.incident_id, event: l.event, ok: !!l.ok, error: l.error })),
    pruneLog: (olderThan) => run('DELETE FROM notification_log WHERE ts < ?', olderThan).changes,
    monitorIds: (id) => all('SELECT monitor_id FROM monitor_channels WHERE channel_id = ?', id).map((r) => r.monitor_id),
    setMonitors(id, monitorIds) {
      tx(db, () => {
        run('DELETE FROM monitor_channels WHERE channel_id = ?', id);
        for (const mid of new Set(monitorIds)) run('INSERT OR IGNORE INTO monitor_channels(monitor_id, channel_id) VALUES (?,?)', mid, id);
      });
    },
    out(r, { redact = true } = {}) {
      const config = parseJson(r.config, {});
      return {
        id: r.id, name: r.name, type: r.type, enabled: !!r.enabled, applyAll: !!r.apply_all, createdAt: r.created_at,
        config: redact ? redactConfig(config) : config, monitorIds: channels.monitorIds(r.id),
      };
    },
  };

   
  const maintenance = {
    list: () => all('SELECT * FROM maintenance ORDER BY starts_at DESC').map(maintenance.out),
    create(m) {
      return tx(db, () => {
        const id = Number(run('INSERT INTO maintenance(name,starts_at,ends_at,created_at) VALUES (?,?,?,?)', m.name, m.startsAt, m.endsAt, Date.now()).lastInsertRowid);
        maintenance.setMonitors(id, m.monitorIds ?? []);
        return id;
      });
    },
    update(id, m) {
      return tx(db, () => {
        const cur = get('SELECT * FROM maintenance WHERE id = ?', id);
        if (!cur) throw notFound('Maintenance window');
        run('UPDATE maintenance SET name=?, starts_at=?, ends_at=? WHERE id=?', m.name ?? cur.name, m.startsAt ?? cur.starts_at, m.endsAt ?? cur.ends_at, id);
        if (m.monitorIds) maintenance.setMonitors(id, m.monitorIds);
      });
    },
    setMonitors(id, monitorIds) {
      run('DELETE FROM maintenance_monitors WHERE maintenance_id = ?', id);
      for (const mid of new Set(monitorIds)) run('INSERT OR IGNORE INTO maintenance_monitors(maintenance_id, monitor_id) VALUES (?,?)', id, mid);
    },
    remove: (id) => run('DELETE FROM maintenance WHERE id = ?', id).changes > 0,
     
    activeFor(monitorId, ts = Date.now()) {
      return get(
        `SELECT m.* FROM maintenance m WHERE m.starts_at <= ? AND m.ends_at > ?
         AND (NOT EXISTS (SELECT 1 FROM maintenance_monitors x WHERE x.maintenance_id = m.id)
              OR EXISTS (SELECT 1 FROM maintenance_monitors x WHERE x.maintenance_id = m.id AND x.monitor_id = ?)) LIMIT 1`, ts, ts, monitorId);
    },
    out: (r) => ({
      id: r.id, name: r.name, startsAt: r.starts_at, endsAt: r.ends_at, createdAt: r.created_at,
      monitorIds: all('SELECT monitor_id FROM maintenance_monitors WHERE maintenance_id = ?', r.id).map((x) => x.monitor_id),
      state: Date.now() < r.starts_at ? 'scheduled' : Date.now() < r.ends_at ? 'active' : 'past',
    }),
  };

   
  const pages = {
    list: () => all('SELECT * FROM status_pages ORDER BY title COLLATE NOCASE').map(pages.out),
    bySlug: (slug) => get('SELECT * FROM status_pages WHERE slug = ?', slug),
    byId: (id) => get('SELECT * FROM status_pages WHERE id = ?', id),
    create(p) {
      return tx(db, () => {
        const id = Number(run('INSERT INTO status_pages(slug,title,description,created_at) VALUES (?,?,?,?)', p.slug, p.title, p.description ?? null, Date.now()).lastInsertRowid);
        pages.setMonitors(id, p.monitors ?? []);
        return id;
      });
    },
    update(id, p) {
      return tx(db, () => {
        const cur = pages.byId(id);
        if (!cur) throw notFound('Status page');
        run('UPDATE status_pages SET slug=?, title=?, description=? WHERE id=?', p.slug ?? cur.slug, p.title ?? cur.title, p.description !== undefined ? p.description : cur.description, id);
        if (p.monitors) pages.setMonitors(id, p.monitors);
      });
    },
    setMonitors(id, list) {
      run('DELETE FROM status_page_monitors WHERE page_id = ?', id);
      list.forEach((m, i) => run('INSERT OR IGNORE INTO status_page_monitors(page_id,monitor_id,label,position) VALUES (?,?,?,?)', id, m.monitorId, m.label ?? null, i));
    },
    monitors: (id) => all(
      `SELECT s.monitor_id, s.label, m.name, m.status FROM status_page_monitors s JOIN monitors m ON m.id = s.monitor_id WHERE s.page_id = ? ORDER BY s.position`, id),
    remove: (id) => run('DELETE FROM status_pages WHERE id = ?', id).changes > 0,
    isPublic: (monitorId) => !!get('SELECT 1 x FROM status_page_monitors WHERE monitor_id = ? LIMIT 1', monitorId),
    announcements: (id, includeExpired = false) => all(
      `SELECT * FROM announcements WHERE page_id = ? ${includeExpired ? '' : 'AND (expires_at IS NULL OR expires_at > ' + Date.now() + ')'} ORDER BY created_at DESC LIMIT 20`, id)
      .map((a) => ({ id: a.id, title: a.title, body: a.body, level: a.level, createdAt: a.created_at, expiresAt: a.expires_at })),
    addAnnouncement: (pageId, a) => Number(run('INSERT INTO announcements(page_id,title,body,level,created_at,expires_at) VALUES (?,?,?,?,?,?)', pageId, a.title, a.body ?? null, a.level ?? 'info', Date.now(), a.expiresAt ?? null).lastInsertRowid),
    removeAnnouncement: (pageId, id) => run('DELETE FROM announcements WHERE id = ? AND page_id = ?', id, pageId).changes > 0,
    out: (r) => ({
      id: r.id, slug: r.slug, title: r.title, description: r.description, createdAt: r.created_at,
      monitors: pages.monitors(r.id).map((m) => ({ monitorId: m.monitor_id, label: m.label, name: m.name })),
      announcements: pages.announcements(r.id, true),
    }),
  };

   
  const settings = {
    get: (key, fallback = null) => { const r = get('SELECT value FROM settings WHERE key = ?', key); return r ? parseJson(r.value, fallback) : fallback; },
    set: (key, value) => run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value)),
    all: () => Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, parseJson(r.value)])),
  };

  return { db, users, sessions, tokens, monitors, checks, incidents, channels, maintenance, pages, settings, get, all, run, q };
}

const SECRET_KEYS = /(secret|token|password|pass|key|webhook_?url|url)$/i;
 
export function redactConfig(config) {
  const out = {};
  for (const [k, v] of Object.entries(config ?? {})) {
    if (typeof v === 'string' && v && SECRET_KEYS.test(k) && /(secret|token|password|pass|key)$/i.test(k)) out[k] = '••••••••';
    else if (typeof v === 'string' && /url$/i.test(k)) out[k] = maskUrl(v);
    else out[k] = v;
  }
  return out;
}
function maskUrl(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.host}/••••••`; } catch { return '••••••••'; }
}
export const MASK = '••••••••';
export { placeholders, DAY, HOUR };
