/**
 * Where the app finds the server (agreed 2026-11-20, Cloudflare Pages move).
 *
 * The live app ALWAYS calls its own site: Cloudflare Pages forwards /api/* to the server over Cloudflare's internal
 * connection (frontend/functions/api/[[path]].ts). Phones never call the server's own address: from Indian networks
 * that is served from abroad (measured ~4x slower), while the Pages site is served from Mumbai.
 * Development: the Vite dev server forwards /api (vite.config.ts); VITE_API_URL can point elsewhere if needed.
 */
export const API_BASE_URL = (import.meta.env.DEV ? import.meta.env.VITE_API_URL || '' : '').replace(/\/+$/, '');

/** Next 00:00 UTC (05:30 India time), when Cloudflare's free daily allowances renew. */
function nextUtcMidnight(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/**
 * Cloudflare answers with its own error page (error 1027) when the free plan's 100,000 requests per day are used up.
 * Turned into the same answer the server gives for its daily limits, so the app shows one clear message
 * ("...has been reached. It renews at 5:30 AM") and keeps waiting changes queued. null for anything else.
 */
export function cloudflareLimitBody(status: number, text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  const isLimitPage = /error[^0-9]{0,20}1027\b/i.test(text) || (status === 429 && /cloudflare/i.test(text));
  if (!isLimitPage) return null;
  return {
    error: "The cloud's free daily request limit has been reached.",
    code: 'daily_limit',
    kind: 'requests',
    resets_at: nextUtcMidnight(),
  };
}
