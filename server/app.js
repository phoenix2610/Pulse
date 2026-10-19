import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createModels } from './models.js';
import { createPipeline } from './pipeline.js';
import { Scheduler } from './scheduler.js';
import { createStats } from './stats.js';
import { createRetention } from './retention.js';
import { createAuth } from './auth.js';
import { createExporter } from './exporter.js';
import { Router, runHandlers, parseBody, sendJson, createStaticServer } from './http.js';
import { Bus, HttpError, createLogger } from './util.js';
import { authRoutes } from './routes/auth.js';
import { monitorRoutes } from './routes/monitors.js';
import { incidentRoutes } from './routes/incidents.js';
import { channelRoutes } from './routes/channels.js';
import { maintenanceRoutes, statusPageRoutes, systemRoutes } from './routes/misc.js';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";





export function createApp(overrides = {}, { fetchImpl } = {}) {
  const config = loadConfig(overrides);
  const log = overrides.logger ?? createLogger(config.logLevel);
  const db = openDb(config.dbFile);
  const models = createModels(db);
  const bus = new Bus();
  const stats = createStats(models);
  const pipeline = createPipeline({ models, bus, config, log, fetchImpl });
  const scheduler = new Scheduler({ models, execute: pipeline.execute, concurrency: config.concurrency, log, retryDelayMs: overrides.retryDelayMs });
  const retention = createRetention({ models, config, log });
  const auth = createAuth({ models, config });
  const exporter = createExporter({ models, scheduler });
  const router = new Router();
  const serveStatic = createStaticServer(path.resolve(config.publicDir));

  const deps = { router, models, auth, bus, stats, scheduler, pipeline, config, log, exporter, fetchImpl };
  authRoutes(deps);
  monitorRoutes(deps);
  incidentRoutes(deps);
  channelRoutes(deps);
  maintenanceRoutes(deps);
  statusPageRoutes(deps);
  systemRoutes(deps);

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    if (!pathname.startsWith('/badge/')) res.setHeader('content-security-policy', CSP);

    const isApi = pathname.startsWith('/api/') || pathname.startsWith('/badge/') || pathname === '/healthz';
    try {
      if (!isApi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        const sp = pathname.startsWith('/status/') ? '/status.html' : pathname;
        if (serveStatic(req, res, sp)) return;
        throw new HttpError(404, 'Not found');
      }
      const { route, params, pathMatched } = router.match(req.method, pathname);
      if (!route) {
        if (pathMatched) throw new HttpError(405, 'Method not allowed');
        throw new HttpError(404, 'Not found');
      }
      const ctx = {
        req, res, url, params, query: Object.fromEntries(url.searchParams), status: 200, user: null, handled: false,
        body: await parseBody(req),
        raw(status, body, headers) { ctx.handled = true; res.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers }); res.end(body); },
      };
      const result = await runHandlers(route.handlers, ctx);
      if (ctx.handled || res.writableEnded) return;
      if (result === undefined) { res.writeHead(204); res.end(); return; }
      sendJson(res, ctx.status, result);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.message, ...(e.details ? { details: e.details } : {}) });
      } else {
        log.error(`${req.method} ${pathname}`, e);
        sendJson(res, 500, { error: 'Internal server error' });
      }
    } finally {
      if (isApi && pathname !== '/api/events' && config.logLevel === 'debug') {
        log.debug(`${req.method} ${pathname} ${res.statusCode} ${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)}ms`);
      }
    }
  }

  const server = http.createServer(handle);
  server.keepAliveTimeout = 65_000;

  return {
    config, db, models, bus, stats, pipeline, scheduler, server, deps,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
      if (config.schedulerEnabled) { scheduler.start(); retention.start(); }
      const addr = server.address();
      config.port = addr.port;  
      log.info(`Pulse listening on http://${config.host}:${addr.port}  (data: ${config.dataDir})`);
      return addr;
    },
    async stop() {
      scheduler.stop();
      retention.stop();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      db.close();
    },
  };
}
