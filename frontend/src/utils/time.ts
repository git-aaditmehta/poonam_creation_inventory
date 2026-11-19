/**
 * Indian time everywhere (agreed 2026-11-19). Times are STORED in UTC (correct practice) and always SHOWN in
 * Indian Standard Time, fixed — not the phone's own time-zone setting — so every report reads the same.
 *
 * Stored formats seen in the app:
 *   "2026-11-18 16:00:00"        server database (UTC, no zone marker)
 *   "2026-11-18T16:00:00.000Z"   ISO (UTC), e.g. created on the phone
 */
export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MINUTES = 330; // UTC+05:30, no daylight saving

/** Parses any stored timestamp as UTC. Returns null for empty/invalid values. */
export function parseTimestamp(ts: string | number | Date | null | undefined): Date | null {
  if (ts === null || ts === undefined || ts === '') return null;
  if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
  if (typeof ts === 'number') return new Date(ts);
  const s = String(ts).trim();
  // "YYYY-MM-DD HH:MM:SS" (server, UTC without a zone marker) → mark it as UTC
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(s);
  const d = new Date(m ? `${m[1]}T${m[2]}Z` : s);
  return isNaN(d.getTime()) ? null : d;
}

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: BUSINESS_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});
const dateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: BUSINESS_TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric' });

/** "18 Nov 2026, 09:30 pm" in Indian time; "—" when unknown. */
export function formatIST(ts: string | number | Date | null | undefined): string {
  const d = parseTimestamp(ts);
  return d ? dateTimeFmt.format(d) : '—';
}

/** "18 Nov 2026" in Indian time. */
export function formatISTDate(ts: string | number | Date | null | undefined): string {
  const d = parseTimestamp(ts);
  return d ? dateFmt.format(d) : '—';
}

/** Today's date in India as "YYYY-MM-DD" (for file names and default filters). */
export function todayIST(): string {
  const d = new Date(Date.now() + IST_OFFSET_MINUTES * 60_000);
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD HH:MM:SS" (UTC) of midnight at the START of an Indian calendar day "YYYY-MM-DD". */
export function istDayStartUtc(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() - IST_OFFSET_MINUTES);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** "YYYY-MM-DD HH:MM:SS" (UTC) of midnight at the END of an Indian calendar day (exclusive bound). */
export function istDayEndUtc(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCMinutes(d.getUTCMinutes() - IST_OFFSET_MINUTES);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * When the cloud's free daily limits renew: 00:00 UTC = 05:30 India time. Returns "today at 5:30 AM" or
 * "tomorrow at 5:30 AM" (India time) for messages.
 */
export function cloudLimitResetText(now = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes < 5 * 60 + 30 ? 'today at 5:30 AM (India time)' : 'tomorrow at 5:30 AM (India time)';
}
