import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, SessionData } from '../types';
import { hashSessionToken } from '../utils/crypto';

/**
 * Auth middleware: validates session token from cookie,
 * looks up the HASH in D1 (raw token never stored),
 * and attaches user info to context.
 */
export async function authMiddleware(c: Context<{ Bindings: Env; Variables: { session: SessionData } }>, next: Next) {
  let token: string | undefined;
  const authHeader = c.req.header('Authorization') || c.req.header('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }
  if (!token) {
    token = getCookie(c, 'session_token');
  }

  if (!token) {
    return c.json({ error: 'Authentication required' }, 401);
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
