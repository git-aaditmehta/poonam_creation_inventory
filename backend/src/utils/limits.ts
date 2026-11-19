/**
 * Cloudflare D1 free plan daily limits (5,000,000 rows read, 100,000 rows written per day). When one is used up,
 * every query fails until 00:00 UTC (05:30 India time) with an error such as
 * "D1_ERROR: Your account has exceeded D1's free tier daily row write limit".
 * The app turns that into one clear answer (code "daily_limit") so every screen can say what happened and when
 * it renews, and queued changes wait instead of failing.
 */
export function dailyLimitKind(err: unknown): 'read' | 'write' | null {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (!/daily/i.test(msg) || !/limit/i.test(msg)) return null;
  if (/row\s*write|rows?\s*written/i.test(msg)) return 'write';
  if (/row\s*read|rows?\s*read/i.test(msg)) return 'read';
  return /free tier|D1/i.test(msg) ? 'write' : null;
}

/** Next renewal: 00:00 UTC. */
export function nextDailyReset(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

export function dailyLimitBody(kind: 'read' | 'write') {
  return {
    error:
      kind === 'write'
        ? "The cloud's free daily limit for saving changes has been reached. It renews at 5:30 AM (India time)."
        : "The cloud's free daily limit for reading data has been reached. It renews at 5:30 AM (India time).",
    code: 'daily_limit',
    kind,
    resets_at: nextDailyReset(),
  };
}
