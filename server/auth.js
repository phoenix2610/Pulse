import { parseCookies, cookie } from './http.js';
import { HttpError, unauthorized, forbidden } from './util.js';

export const SESSION_COOKIE = 'pulse_sid';

export function createAuth({ models, config }) {
   
  function authenticate(req) {
    const authz = req.headers.authorization;
    if (authz?.startsWith('Bearer ')) {
      const secret = authz.slice(7).trim();
      const t = secret.startsWith('pls_') ? models.tokens.byToken(secret) : null;
      if (!t) throw unauthorized('Invalid API token');
      models.tokens.touch(t.id);
      return { id: t.user_id, email: t.email, name: t.name, via: 'token', readOnly: !!t.read_only };
    }
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!sid) return null;
    const s = models.sessions.byToken(sid);
    if (!s) return null;
    return { id: s.user_id, email: s.email, name: s.name, via: 'session', sessionToken: sid, readOnly: false };
  }

   
  async function requireAuth(ctx, next) {
    const user = authenticate(ctx.req);
    if (!user) throw unauthorized();
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method);
    if (mutating) {
      if (user.readOnly) throw forbidden('This API token is read-only');
      if (user.via === 'session') {
         
        const ct = ctx.req.headers['content-type'] || '';
        const origin = ctx.req.headers.origin;
        const host = ctx.req.headers.host;
        if (origin && new URL(origin).host !== host) throw forbidden('Cross-origin request blocked');
        if (!ct.includes('application/json') && ctx.req.headers['x-pulse'] !== '1' && ctx.req.headers['content-length'] !== '0' && ctx.req.headers['content-length'] !== undefined) {
          throw new HttpError(415, 'Use application/json');
        }
      }
    }
    ctx.user = user;
    return next();
  }

  const setSessionCookie = (res, token) => {
    res.setHeader('set-cookie', cookie(SESSION_COOKIE, token, { maxAgeS: Math.floor(config.sessionTtlMs / 1000), secure: config.cookieSecure }));
  };
  const clearSessionCookie = (res) => {
    res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', { maxAgeS: 0, secure: config.cookieSecure }));
  };

  return { authenticate, requireAuth, setSessionCookie, clearSessionCookie };
}
