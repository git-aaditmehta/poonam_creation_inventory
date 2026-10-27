import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { Env, SessionData } from '../types';
import {
  hashPassword, verifyPassword, generateSessionToken,
  hashSessionToken, generateId,
} from '../utils/crypto';
import { authMiddleware, ownerOnly } from '../middleware/auth';

const auth = new Hono<{ Bindings: Env; Variables: { session: SessionData } }>();

const SESSION_DURATION_HOURS = 72; // 3 days

// In-memory sliding window rate limiter for login brute-force protection
const failedAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes lockout

function getRateLimitKey(c: any, identifier: string): string {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '127.0.0.1';
  return `${ip}::${identifier.toLowerCase().trim()}`;
}

export function validatePasswordComplexity(password: string): string | null {
  if (password.length < 8) {
    return 'Password must be at least 8 characters long';
  }
  if (!/[a-zA-Z]/.test(password)) {
    return 'Password must contain at least one letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  return null;
}

/** POST /api/auth/login */
auth.post('/login', async (c) => {
  const body = await c.req.json<{ username?: string; email?: string; password?: string }>();
  const { username, email, password } = body;

  if (!password || (!username && !email)) {
    return c.json({ error: 'Username/email and password are required' }, 400);
  }

  const identifier = (username || email || '').trim();
  const limitKey = getRateLimitKey(c, identifier);
  const now = Date.now();
  const record = failedAttempts.get(limitKey);

  // Check if locked
  if (record && record.lockedUntil > now) {
    const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return c.json({
      error: `Too many failed login attempts. Please try again in ${remainingSeconds} seconds.`,
      retry_after: remainingSeconds,
    }, 429);
  }

  // Look up user by username or email (case-insensitive)
  const user = await c.env.DB.prepare(
    `SELECT id, username, email, password_hash, role, is_active
     FROM users WHERE (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) AND is_active = 1`
  ).bind(username || '', email || '').first<{
    id: string; username: string; email: string | null;
    password_hash: string; role: 'owner' | 'staff'; is_active: number;
  }>();

  if (!user) {
    const newCount = (record?.count ?? 0) + 1;
    if (newCount >= MAX_FAILED_ATTEMPTS) {
      failedAttempts.set(limitKey, { count: newCount, lockedUntil: now + LOCKOUT_DURATION_MS });
      return c.json({
        error: 'Too many failed login attempts. Account temporarily locked for 5 minutes.',
        retry_after: 300,
      }, 429);
    } else {
      failedAttempts.set(limitKey, { count: newCount, lockedUntil: 0 });
      return c.json({ error: 'Invalid credentials' }, 401);
    }
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    const newCount = (record?.count ?? 0) + 1;
    if (newCount >= MAX_FAILED_ATTEMPTS) {
      failedAttempts.set(limitKey, { count: newCount, lockedUntil: now + LOCKOUT_DURATION_MS });
      return c.json({
        error: 'Too many failed login attempts. Account temporarily locked for 5 minutes.',
        retry_after: 300,
      }, 429);
    } else {
      failedAttempts.set(limitKey, { count: newCount, lockedUntil: 0 });
      return c.json({ error: 'Invalid credentials' }, 401);
    }
  }

  // Reset rate limiting on successful login
  failedAttempts.delete(limitKey);

  // Generate session: raw token goes to cookie, hash goes to D1
  const rawToken = generateSessionToken();
  const tokenHash = await hashSessionToken(rawToken);
  const sessionId = generateId();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`
  ).bind(sessionId, user.id, tokenHash, expiresAt).run();

  // Opportunistic cleanup of expired or revoked sessions older than 7 days
  const cleanupPromise = c.env.DB.prepare(
    `DELETE FROM sessions WHERE expires_at < datetime('now', '-7 days') OR (is_revoked = 1 AND created_at < datetime('now', '-7 days'))`
  ).run().catch(() => {});
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(cleanupPromise);
  }

  const isHttps = c.req.url.startsWith('https://') || c.req.header('x-forwarded-proto') === 'https';

  setCookie(c, 'session_token', rawToken, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DURATION_HOURS * 60 * 60,
  });

  return c.json({
    user: { id: user.id, username: user.username, role: user.role },
    session_token: rawToken,
  });
});

/** POST /api/auth/logout */
auth.post('/logout', authMiddleware, async (c) => {
  const session = c.get('session');

  await c.env.DB.prepare(
    `UPDATE sessions SET is_revoked = 1 WHERE id = ?`
  ).bind(session.sessionId).run();

  const isHttps = c.req.url.startsWith('https://') || c.req.header('x-forwarded-proto') === 'https';
  deleteCookie(c, 'session_token', {
    path: '/',
    secure: isHttps,
    sameSite: 'Lax',
  });
  return c.json({ success: true });
});

/** GET /api/auth/me — check current session */
auth.get('/me', authMiddleware, async (c) => {
  const session = c.get('session');
  return c.json({
    user: { id: session.userId, username: session.username, role: session.role },
  });
});

/** POST /api/auth/bootstrap — one-time owner account creation */
auth.post('/bootstrap', async (c) => {
  // Check if owner already exists
  const existing = await c.env.DB.prepare(
    `SELECT id FROM users WHERE role = 'owner' LIMIT 1`
  ).first();

  if (existing) {
    return c.json({ error: 'Owner account already exists' }, 409);
  }

  const ownerEmail = c.env.OWNER_EMAIL;
  const ownerPassword = c.env.OWNER_PASSWORD;
  if (!ownerEmail || !ownerPassword) {
    return c.json({ error: 'Owner credentials not configured in environment' }, 500);
  }

  const passwordHash = await hashPassword(ownerPassword);
  const ownerId = generateId();

  await c.env.DB.prepare(
    `INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, 'owner')`
  ).bind(ownerId, ownerEmail, ownerEmail, passwordHash).run();

  return c.json({ success: true, message: 'Owner account created' });
});

// --- Staff Management (Owner only) ---

/** POST /api/auth/staff — create staff account */
auth.post('/staff', authMiddleware, ownerOnly, async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>();
  if (!body.username || !body.password) {
    return c.json({ error: 'Username and password are required' }, 400);
  }
  if (body.username.length < 3 || body.username.length > 50) {
    return c.json({ error: 'Username must be 3-50 characters' }, 400);
  }
  const complexityError = validatePasswordComplexity(body.password);
  if (complexityError) {
    return c.json({ error: complexityError }, 400);
  }

  // Check for duplicate username (case-insensitive)
  const existing = await c.env.DB.prepare(
    `SELECT id FROM users WHERE username = ? COLLATE NOCASE`
  ).bind(body.username).first();
  if (existing) {
    return c.json({ error: 'Username already exists' }, 409);
  }

  const passwordHash = await hashPassword(body.password);
  const staffId = generateId();

  await c.env.DB.prepare(
    `INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, 'staff')`
  ).bind(staffId, body.username, passwordHash).run();

  return c.json({ success: true, staff: { id: staffId, username: body.username } });
});

/** GET /api/auth/staff — list staff accounts */
auth.get('/staff', authMiddleware, ownerOnly, async (c) => {
  const staffList = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.is_active, u.created_at,
            EXISTS(SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.is_revoked = 0 AND s.expires_at > datetime('now')) as has_active_session
     FROM users u WHERE u.role = 'staff' ORDER BY u.created_at DESC`
  ).all();

  return c.json({ staff: staffList.results });
});

/** POST /api/auth/staff/:id/force-logout — revoke all sessions */
auth.post('/staff/:id/force-logout', authMiddleware, ownerOnly, async (c) => {
  const staffId = c.req.param('id');
  await c.env.DB.prepare(
    `UPDATE sessions SET is_revoked = 1 WHERE user_id = ? AND is_revoked = 0`
  ).bind(staffId).run();
  return c.json({ success: true });
});

/** PATCH /api/auth/staff/:id — toggle active status */
auth.patch('/staff/:id', authMiddleware, ownerOnly, async (c) => {
  const staffId = c.req.param('id');
  const body = await c.req.json<{ is_active?: boolean }>();
  if (body.is_active === undefined) {
    return c.json({ error: 'is_active is required' }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ? AND role = 'staff'`
  ).bind(body.is_active ? 1 : 0, staffId).run();

  // If deactivating, revoke all sessions
  if (!body.is_active) {
    await c.env.DB.prepare(
      `UPDATE sessions SET is_revoked = 1 WHERE user_id = ? AND is_revoked = 0`
    ).bind(staffId).run();
  }

  return c.json({ success: true });
});

/** POST /api/auth/staff/:id/password — reset staff password (owner only) */
auth.post('/staff/:id/password', authMiddleware, ownerOnly, async (c) => {
  const staffId = c.req.param('id');
  const body = await c.req.json<{ new_password?: string }>();
  if (!body.new_password) {
    return c.json({ error: 'New password is required' }, 400);
  }

  const complexityError = validatePasswordComplexity(body.new_password);
  if (complexityError) {
    return c.json({ error: complexityError }, 400);
  }

  const passwordHash = await hashPassword(body.new_password);
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ? AND role = 'staff'`
  ).bind(passwordHash, staffId).run();

  // Revoke existing sessions so staff must log in with new password
  await c.env.DB.prepare(
    `UPDATE sessions SET is_revoked = 1 WHERE user_id = ? AND is_revoked = 0`
  ).bind(staffId).run();

  return c.json({ success: true });
});

/** POST /api/auth/change-password — allow authenticated user to update their own password */
auth.post('/change-password', authMiddleware, async (c) => {
  const session = c.get('session');
  const body = await c.req.json<{ current_password?: string; new_password?: string }>();
  const { current_password, new_password } = body;

  if (!current_password || !new_password) {
    return c.json({ error: 'Current password and new password are required' }, 400);
  }

  const complexityError = validatePasswordComplexity(new_password);
  if (complexityError) {
    return c.json({ error: complexityError }, 400);
  }

  const user = await c.env.DB.prepare(
    'SELECT password_hash FROM users WHERE id = ?'
  ).bind(session.userId).first<{ password_hash: string }>();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  const valid = await verifyPassword(current_password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  const newHash = await hashPassword(new_password);
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(newHash, session.userId).run();

  // Revoke all other sessions for this user, keeping the current session active
  await c.env.DB.prepare(
    `UPDATE sessions SET is_revoked = 1 WHERE user_id = ? AND id != ? AND is_revoked = 0`
  ).bind(session.userId, session.sessionId).run();

  return c.json({ success: true, message: 'Password updated successfully' });
});

export default auth;
