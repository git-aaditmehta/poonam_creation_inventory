/**
 * Session lifetime: "stays signed in while used".
 *
 * A login is valid for SESSION_DURATION_MS. Every authenticated request that arrives more than
 * RENEW_INTERVAL_MS after the last renewal pushes the expiry SESSION_DURATION_MS ahead again, so a
 * device that is used at least once a month never gets logged out.
 *
 * A session still ends when:
 *   - the user taps Logout (that session is revoked),
 *   - the owner deactivates the user or resets their password (all their sessions are revoked),
 *   - the user changes their password (their other sessions are revoked),
 *   - the device is not used for SESSION_DURATION_MS.
 *
 * Renewal writes to D1 at most once per RENEW_INTERVAL_MS per session (not on every request),
 * which keeps database writes negligible on the free plan.
 */
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000; // renew at most once a day

/** Expiry timestamp (ISO) for a session created or renewed at `now`. */
export function sessionExpiryFrom(now: number = Date.now()): string {
  return new Date(now + SESSION_DURATION_MS).toISOString();
}

/**
 * True when the session's expiry should be pushed forward: it was last set (at login or renewal)
 * more than RENEW_INTERVAL_MS ago. Invalid dates never renew (the caller rejects them as expired).
 */
export function shouldRenewSession(expiresAt: string, now: number = Date.now()): boolean {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= now) return false;
  return expiresMs - now < SESSION_DURATION_MS - RENEW_INTERVAL_MS;
}
