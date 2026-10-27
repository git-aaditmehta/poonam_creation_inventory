import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, SessionData } from '../types';
import { hashSessionToken } from '../utils/crypto';

/**
 * Auth middleware: validates session token from cookie,
 * looks up the HASH in D1 (raw token never stored),
 * and attaches user info to context.
 */
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'https://poonam-creation-inventory.vercel.app',
];

export async function authMiddleware(c: Context<{ Bindings: Env; Variables: { session: SessionData } }>, next: Next) {
  let token: string | undefined;
  let isCookieAuth = false;

  const authHeader = c.req.header('Authorization') || c.req.header('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }
  if (!token) {
    token = getCookie(c, 'session_token');
    if (token) isCookieAuth = true;
  }

  if (!token) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  // Anti-CSRF: If authenticated via cookie on a state-changing method, verify Origin
  if (isCookieAuth && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    const origin = c.req.header('Origin') || c.req.header('origin');
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return c.json({ error: 'Cross-origin request rejected' }, 403);
    }
  }

  const tokenHash = await hashSessionToken(token);
  const row = await c.env.DB.prepare(
    `SELECT s.id as session_id, s.user_id, s.expires_at, s.is_revoked,
            u.username, u.role, u.is_active
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.token_hash = ? AND s.is_revoked = 0`
  ).bind(tokenHash).first<{
    session_id: string;
    user_id: string;
    expires_at: string;
    is_revoked: number;
    username: string;
    role: 'owner' | 'staff';
    is_active: number;
  }>();

  if (!row) {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  if (new Date(row.expires_at) < new Date()) {
    return c.json({ error: 'Session expired' }, 401);
  }

  if (!row.is_active) {
    return c.json({ error: 'Account is deactivated' }, 401);
  }

  c.set('session', {
    userId: row.user_id,
    username: row.username,
    role: row.role,
    sessionId: row.session_id,
  });

  await next();
}

/** Middleware that requires the owner role. */
export async function ownerOnly(c: Context<{ Bindings: Env; Variables: { session: SessionData } }>, next: Next) {
  const session = c.get('session');
  if (session.role !== 'owner') {
    return c.json({ error: 'Owner access required' }, 403);
  }
  await next();
}
