/**
 * Date filters are Indian calendar days (agreed 2026-11-19): "18 Nov" means 18 Nov 00:00–24:00 IST.
 * Timestamps are stored in UTC ("YYYY-MM-DD HH:MM:SS", from datetime('now')), so the bounds are shifted
 * by the IST offset (UTC+05:30, no daylight saving). Keep in line with frontend/src/utils/time.ts.
 */
export const IST_DAY_START_SQL = "datetime(?, '-330 minutes')";
export const IST_DAY_END_SQL = "datetime(?, '+1 day', '-330 minutes')";

/** A valid "YYYY-MM-DD" date (the only format the date filters accept). */
export function isYmd(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(`${v}T00:00:00Z`));
}
