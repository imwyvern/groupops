import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool, tx } from './db.js';
import { config } from './config.js';
import { ApiError } from './errors.js';

export interface AuthUser { sub: number; username: string; role: 'admin' | 'viewer'; sid: string; jti: string; exp: number }

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const unauthorized = (msg = 'unauthorized') => new ApiError(401, 'UNAUTHORIZED', msg);

function sign(payload: object) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = createHmac('sha256', config.jwtSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Signature + expiry + server-side revocation (logout revokes the jti, refresh reuse revokes the session). */
export async function verifyAccessToken(token: unknown): Promise<AuthUser> {
  if (typeof token !== 'string') throw unauthorized();
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) throw unauthorized();
  const expected = createHmac('sha256', config.jwtSecret).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw unauthorized();
  const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as AuthUser;
  if (p.exp * 1000 < Date.now()) throw unauthorized('token expired');
  const { rows } = await pool.query(
    `SELECT (SELECT revoked_at FROM sessions WHERE id = $1) AS session_revoked,
            EXISTS (SELECT 1 FROM revoked_access_tokens WHERE jti = $2) AS jti_revoked`, [p.sid, p.jti]);
  if (rows[0].session_revoked || rows[0].jti_revoked) throw unauthorized('token revoked');
  return p;
}

function issueAccess(user: { id: number; username: string; role: string }, sid: string) {
  const exp = Math.floor(Date.now() / 1000) + config.accessTtlSec;
  return sign({ sub: user.id, username: user.username, role: user.role, sid, jti: randomUUID(), exp });
}
const newRefresh = (sid: string) => `${sid}.${randomBytes(32).toString('base64url')}`;
const cookieOpts = { httpOnly: true, sameSite: 'strict' as const, path: '/api/auth', maxAge: config.refreshTtlSec };

export async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw unauthorized();
  return verifyAccessToken(h.slice(7));
}

export function registerAuth(app: FastifyInstance) {
  // Every /api route except login/refresh/health requires a valid token; any write requires admin.
  // onRequest runs before body parsing, so a viewer's malformed write is a 403, not a 400.
  app.addHook('onRequest', async (req) => {
    const url = req.routeOptions.url ?? '';
    if (!url.startsWith('/api/') || url === '/api/health' || url === '/api/auth/login' || url === '/api/auth/refresh') return;
    const user = await authenticate(req);
    (req as any).user = user;
    if (req.method !== 'GET' && url !== '/api/auth/logout' && user.role !== 'admin') {
      throw new ApiError(403, 'FORBIDDEN', 'read-only user');
    }
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as any;
    if (typeof username !== 'string' || typeof password !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', 'username and password required');
    const { rows } = await pool.query('SELECT id, username, role FROM users WHERE username = $1 AND password_hash = crypt($2, password_hash)', [username, password]);
    if (!rows[0]) throw unauthorized('invalid credentials');
    const sid = randomUUID();
    const refresh = newRefresh(sid);
    await pool.query('INSERT INTO sessions (id, user_id, current_refresh) VALUES ($1, $2, $3)', [sid, rows[0].id, sha256(refresh)]);
    reply.setCookie('refresh_token', refresh, cookieOpts);
    return { accessToken: issueAccess(rows[0], sid) };
  });

  /**
   * Rotation with reuse detection: each refresh token is valid exactly once. Presenting a token that
   * was already rotated out revokes the whole session, which also kills every access token minted from it.
   */
  app.post('/api/auth/refresh', async (req, reply) => {
    const token = req.cookies.refresh_token;
    if (!token) throw unauthorized('no refresh token');
    const sid = token.split('.')[0];
    const hash = sha256(token);
    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT s.id, s.current_refresh, s.revoked_at, u.id AS uid, u.username, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 FOR UPDATE OF s`, [sid]);
      const s = rows[0];
      if (!s || s.revoked_at) return { error: 'session revoked' };
      if (s.current_refresh !== hash) {
        const reused = await c.query('SELECT 1 FROM used_refresh_tokens WHERE token_hash = $1 AND session_id = $2', [hash, sid]);
        if (reused.rowCount) await c.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sid]);
        return { error: reused.rowCount ? 'refresh token reuse detected; session revoked' : 'invalid refresh token' };
      }
      const next = newRefresh(sid);
      await c.query('INSERT INTO used_refresh_tokens (token_hash, session_id) VALUES ($1, $2)', [hash, sid]);
      await c.query('UPDATE sessions SET current_refresh = $2 WHERE id = $1', [sid, sha256(next)]);
      return { next, access: issueAccess({ id: s.uid, username: s.username, role: s.role }, sid) };
    });
    if ('error' in result) { reply.clearCookie('refresh_token', { path: '/api/auth' }); throw unauthorized(result.error); }
    reply.setCookie('refresh_token', result.next!, cookieOpts);
    return { accessToken: result.access };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const u = (req as any).user as AuthUser;
    await pool.query('INSERT INTO revoked_access_tokens (jti, expires_at) VALUES ($1, to_timestamp($2)) ON CONFLICT DO NOTHING', [u.jti, u.exp]);
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [u.sid]);
    reply.clearCookie('refresh_token', { path: '/api/auth' });
    return { ok: true };
  });
}
