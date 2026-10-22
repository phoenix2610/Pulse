import { validate } from '../validate.js';
import { HttpError, hashPassword, verifyPassword, unauthorized } from '../util.js';
import { RateLimiter } from '../http.js';

const passwordRule = { type: 'string', required: true, min: 8, max: 200, trim: false };

export function authRoutes({ router, models, auth, config }) {
  const { users, sessions, tokens } = models;
  const loginLimiter = new RateLimiter({ max: 10, windowMs: 10 * 60_000 });
  const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;

  router.get('/api/setup/status', () => ({ needsSetup: users.count() === 0 }));

  router.post('/api/setup', (ctx) => {
    if (users.count() > 0) throw new HttpError(409, 'Setup already completed');
    const b = validate({ email: { type: 'email', required: true }, name: { type: 'string', required: true, min: 1, max: 80 }, password: passwordRule }, ctx.body);
    const id = users.create({ email: b.email, name: b.name, passHash: hashPassword(b.password) });
    const token = sessions.create(id, config.sessionTtlMs, { userAgent: ctx.req.headers['user-agent'], ip: clientIp(ctx.req) });
    auth.setSessionCookie(ctx.res, token);
    ctx.status = 201;
    return { user: users.out(users.byId(id)) };
  });

  router.post('/api/auth/login', (ctx) => {
    const ip = clientIp(ctx.req);
    const rl = loginLimiter.hit(ip);
    if (!rl.ok) {
      ctx.res.setHeader('retry-after', rl.retryAfterS);
      throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(rl.retryAfterS / 60)} min.`);
    }
    const b = validate({ email: { type: 'string', required: true }, password: { type: 'string', required: true, trim: false } }, ctx.body);
    const u = users.byEmail(b.email);
     
    const ok = u ? verifyPassword(b.password, u.pass_hash) : (verifyPassword(b.password, DUMMY), false);
    if (!ok) throw unauthorized('Invalid email or password');
    loginLimiter.clear(ip);
    const token = sessions.create(u.id, config.sessionTtlMs, { userAgent: ctx.req.headers['user-agent'], ip });
    auth.setSessionCookie(ctx.res, token);
    return { user: users.out(u) };
  });

  router.post('/api/auth/logout', (ctx) => {
    const user = auth.authenticate(ctx.req);
    if (user?.sessionToken) sessions.destroy(user.sessionToken);
    auth.clearSessionCookie(ctx.res);
    return { ok: true };
  });

  router.get('/api/auth/me', auth.requireAuth, (ctx) => ({ user: users.out(users.byId(ctx.user.id)), via: ctx.user.via, readOnly: ctx.user.readOnly }));

  router.put('/api/auth/profile', auth.requireAuth, (ctx) => {
    const b = validate({ name: { type: 'string', required: true, min: 1, max: 80 } }, ctx.body);
    users.setName(ctx.user.id, b.name);
    return { user: users.out(users.byId(ctx.user.id)) };
  });

  router.post('/api/auth/password', auth.requireAuth, (ctx) => {
    const b = validate({ current: { type: 'string', required: true, trim: false }, next: passwordRule }, ctx.body);
    const u = users.byId(ctx.user.id);
    if (!verifyPassword(b.current, u.pass_hash)) throw new HttpError(403, 'Current password is incorrect');
    users.setPassword(u.id, hashPassword(b.next));
    sessions.destroyAllFor(u.id, ctx.user.sessionToken);  
    return { ok: true };
  });

  router.get('/api/auth/sessions', auth.requireAuth, (ctx) =>
    sessions.list(ctx.user.id).map((s) => ({ createdAt: s.created_at, expiresAt: s.expires_at, userAgent: s.user_agent, ip: s.ip })));

   
  router.get('/api/tokens', auth.requireAuth, (ctx) => tokens.list(ctx.user.id));
  router.post('/api/tokens', auth.requireAuth, (ctx) => {
    const b = validate({ name: { type: 'string', required: true, min: 1, max: 80 }, readOnly: { type: 'bool', default: false } }, ctx.body);
    const { id, secret } = tokens.create(ctx.user.id, b.name, b.readOnly);
    ctx.status = 201;
    return { id, secret, note: 'Store this now — it will not be shown again.' };
  });
  router.delete('/api/tokens/:id', auth.requireAuth, (ctx) => {
    if (!tokens.remove(ctx.user.id, Number(ctx.params.id))) throw new HttpError(404, 'Token not found');
    return { ok: true };
  });
}

const DUMMY = hashPassword('pulse-dummy-password');
