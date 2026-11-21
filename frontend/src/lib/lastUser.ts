/**
 * The last successfully verified user, so the app can open OFFLINE without showing the login screen.
 * Only ever written after the server confirmed the login (login or /me), and removed on logout or when the
 * server says the login is no longer valid (401). Contains no secrets: id, username and role only.
 */
import type { User } from '../types';

const KEY = 'last_verified_user';

export function saveLastUser(user: User): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ id: user.id, username: user.username, role: user.role, is_active: 1 }));
  } catch {
    /* storage blocked: the app simply needs internet to open */
  }
}

export function loadLastUser(): User | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (u && typeof u.id === 'string' && typeof u.username === 'string' && (u.role === 'owner' || u.role === 'staff')) {
      return u as User;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function clearLastUser(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function hasStoredToken(): boolean {
  try {
    return Boolean(sessionStorage.getItem('session_token') || localStorage.getItem('session_token'));
  } catch {
    return false;
  }
}

/**
 * Whose unsent offline changes are waiting in the queue. Kept across an expired login (401) so the same
 * person's changes are sent after they log in again; a DIFFERENT user logging in on this phone drops them.
 */
const QUEUE_OWNER_KEY = 'pending_queue_owner';

export function getQueueOwner(): string | null {
  try {
    return localStorage.getItem(QUEUE_OWNER_KEY);
  } catch {
    return null;
  }
}

export function setQueueOwner(userId: string | null): void {
  try {
    if (userId) localStorage.setItem(QUEUE_OWNER_KEY, userId);
    else localStorage.removeItem(QUEUE_OWNER_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The username typed at the last successful login on this device (agreed 2026-11-21): shown again on the login
 * screen. Kept after logout; never a password.
 */
const USERNAME_KEY = 'last_login_username';

export function saveLastUsername(username: string): void {
  try {
    localStorage.setItem(USERNAME_KEY, username);
  } catch {
    /* storage blocked: the field is simply empty next time */
  }
}

export function loadLastUsername(): string {
  try {
    return localStorage.getItem(USERNAME_KEY) || '';
  } catch {
    return '';
  }
}
