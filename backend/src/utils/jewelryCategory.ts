/**
 * Jewelry types (agreed 2026-11-21): a design's type is the LEADING LETTERS of its code, ignoring case and
 * surrounding spaces. "ER 120", "er-5", "ER" -> ER (Earring); "ERX 1" is NOT an earring (its letters are ERX).
 * The list of types lives in D1 (jewelry_categories); the owner can add more. Codes whose letters are not a type
 * are "Other". The phone's offline database runs the same SQL (frontend/src/utils/jewelryCategory.ts).
 *
 * Scan (Vectorize metadata "category"): the first five types keep their original names (earring, stud, jhumka,
 * bracelet, pendant_set) so existing fingerprints stay valid; every other type uses its letters (e.g. "NK").
 */

export interface JewelryType {
  prefix: string;
  name: string;
  sort_order: number;
  scan_tagged: number;
}

export const LEGACY_SCAN_KEY: Record<string, string> = {
  ER: 'earring',
  PS: 'stud',
  JK: 'jhumka',
  BR: 'bracelet',
  PD: 'pendant_set',
};
const LEGACY_PREFIX: Record<string, string> = Object.fromEntries(Object.entries(LEGACY_SCAN_KEY).map(([p, k]) => [k, p]));

export const PREFIX_RE = /^[A-Z]{1,5}$/;

/** Leading letters of a design code, upper case ("" when it starts with a digit). */
export function leadingLetters(itemId: string | null | undefined): string {
  const m = String(itemId ?? '').trim().match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : '';
}

/** Value stored in Scan fingerprints for a type's letters. */
export function scanKeyForPrefix(prefix: string): string {
  return LEGACY_SCAN_KEY[prefix] ?? prefix;
}

/** Scan category of a design code: its letters (legacy names for the first five); "other" without letters. */
export function scanCategoryFromItemId(itemId: string | null | undefined): string {
  const p = leadingLetters(itemId);
  return p ? scanKeyForPrefix(p) : 'other';
}

/** A filter value from the app ("NK", or an older app's "earring") -> type letters, or null if not valid. */
export function prefixFromFilter(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (LEGACY_PREFIX[value]) return LEGACY_PREFIX[value];
  const v = value.trim().toUpperCase();
  return PREFIX_RE.test(v) ? v : null;
}

export async function listJewelryTypes(db: D1Database): Promise<JewelryType[]> {
  const res = await db.prepare('SELECT prefix, name, sort_order, scan_tagged FROM jewelry_categories ORDER BY sort_order, prefix').all<JewelryType>();
  return res.results || [];
}

const ID = 'UPPER(TRIM(item_id))';
const prefixSql = (p: string) => ({ sql: `(${ID} = ? OR ${ID} GLOB ?)`, params: [p, `${p}[^A-Z]*`] });

/** SQL condition (with bound params) selecting one type, or "other" (none of the listed types). */
export function jewelryCategoryWhere(prefixOrOther: string, allPrefixes: string[]): { sql: string; params: string[] } {
  if (prefixOrOther !== 'other') return prefixSql(prefixOrOther);
  if (allPrefixes.length === 0) return { sql: '1 = 1', params: [] };
  const parts = allPrefixes.map(prefixSql);
  return { sql: `NOT (${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) };
}
