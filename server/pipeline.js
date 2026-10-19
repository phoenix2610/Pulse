import { runCheck } from './checks/index.js';
import { buildEvent, deliver } from './notifiers/index.js';
import { DAY, formatDuration } from './util.js';









export function createPipeline({ models, bus, config, log, fetchImpl }) {
  const { monitors, checks, incidents, channels, maintenance, settings } = models;

  async function notify(kind, monitorRow, { incident, message } = {}) {
    const targets = channels.forMonitor(monitorRow.id);
    if (!targets.length) return [];
    const event = buildEvent(kind, { monitor: monitorRow, incident, baseUrl: config.baseUrl || settings.get('baseUrl', ''), message });
    return Promise.all(targets.map(async (ch) => {
      const r = await deliver(ch, event, { fetchImpl, backoffMs: config.notifyBackoffMs });
      channels.log(ch.id, incident?.id, kind, r.ok, r.error);
      if (!r.ok) log.warn(`notify ${ch.name} (${ch.type}) failed: ${r.error}`);
      bus.emit('notification', { channelId: ch.id, kind, ok: r.ok, monitorId: monitorRow.id });
      return { channelId: ch.id, ...r };
    }));
  }

   
  function handleResult(monitorId, result, ts = Date.now()) {
    const m = monitors.row(monitorId);
    if (!m || !m.enabled) return null;

    const inMaintenance = !!maintenance.activeFor(m.id, ts);
    const ok = !!result.ok;
    checks.insert(m.id, { ts, ok, latencyMs: result.latencyMs, statusCode: result.statusCode, error: result.error, maintenance: inMaintenance });

    let status = m.status;
    let failures = ok ? 0 : m.consecutive_failures + 1;
    let changedAt = null;
    let transition = null;

    if (inMaintenance) {
      if (status !== 'maintenance') changedAt = ts;
      status = 'maintenance';
      failures = 0;
    } else if (ok) {
      if (status !== 'up') { changedAt = ts; transition = status === 'down' ? 'recovered' : 'up'; }
      status = 'up';
    } else if (failures >= Math.max(1, m.retries)) {
      if (status !== 'down') { changedAt = ts; transition = 'down'; }
      status = 'down';
    } else {
       
      if (status === 'up' || status === 'maintenance') changedAt = ts;
      if (status !== 'down') status = 'pending';
    }
    monitors.applyState(m.id, {
      status, consecutiveFailures: failures, checkedAt: ts, changedAt,
      latencyMs: result.latencyMs, error: ok ? null : result.error, meta: result.meta, certExpiresAt: result.certExpiresAt,
    });

    const fresh = monitors.row(m.id);
    bus.emit('check', { monitorId: m.id, ok, ts, latencyMs: result.latencyMs ?? null, status, error: ok ? null : result.error ?? null, maintenance: inMaintenance });
    if (changedAt) bus.emit('status', { monitorId: m.id, name: m.name, from: m.status, to: status, ts });

    let incident = null;
    if (transition === 'down') {
       
      const existing = incidents.openFor(m.id);
      if (existing) return { status, transition: null, incident: incidents.row(existing.id) };
      incident = incidents.row(incidents.open(m.id, result.error, ts));
      bus.emit('incident', { id: incident.id, monitorId: m.id, state: 'opened', cause: result.error });
      notify('down', fresh, { incident }).then((res) => {
        if (res.length) incidents.addEvent(incident.id, 'notified', null, `Alert sent to ${res.filter((r) => r.ok).length}/${res.length} channel(s)`);
      });
    } else if (transition === 'recovered' || (ok && status === 'up' && incidents.openFor(m.id))) {
      const open = incidents.openFor(m.id);
      if (open) {
        incidents.resolve(open.id, ts);
        incident = incidents.row(open.id);
        bus.emit('incident', { id: open.id, monitorId: m.id, state: 'resolved' });
        notify('up', fresh, { incident });
      }
    }

    maybeAlertCert(fresh, result, ts);
    return { status, transition, incident };
  }

  function maybeAlertCert(m, result, ts) {
    if (!m.cert_expires_at || !result.ok) return;
    const warnDays = settings.get('certWarnDays', 14);
    const daysLeft = Math.floor((m.cert_expires_at - ts) / DAY);
    if (daysLeft > warnDays) return;
    if (m.cert_alerted_at && ts - m.cert_alerted_at < DAY) return;
    monitors.markCertAlerted(m.id, ts);
    notify('cert', m, { message: daysLeft < 0 ? 'The certificate has expired.' : `The certificate expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.` });
  }

   
  async function execute(monitorId) {
    const m = monitors.row(monitorId);
    if (!m || !m.enabled) return null;
    let result;
    try {
      result = await runCheck({ ...m, config: JSON.parse(m.config) });
    } catch (e) {
      result = { ok: false, error: `Checker crashed: ${e.message}` };
    }
    return { result, ...handleResult(monitorId, result) };
  }

  return { handleResult, execute, notify };
}

export { formatDuration };
