/**
 * Jewelry type from the item ID prefix — the same rule as the DINO scan category
 * (backend/src/routes/visual-search-dino.ts, categoryFromItemId): the LEADING LETTERS of the ID, ignoring
 * case and surrounding spaces. "ER 120", "er-5", "ER" → earring; "ERX 1" is NOT an earring (its prefix is ERX).
 * The same SQL runs on the phone's offline database and on the server (both SQLite):
 * keep backend/src/utils/jewelryCategory.ts identical.
 */
export type JewelryCategory = 'earring' | 'stud' | 'jhumka' | 'bracelet' | 'pendant_set' | 'other';

export const JEWELRY_CATEGORY_PREFIX: Record<Exclude<JewelryCategory, 'other'>, string> = {
  earring: 'ER',
  stud: 'PS',
  jhumka: 'JK',
  bracelet: 'BR',
  pendant_set: 'PD',
};

/** Chips shown above the Plated and Raw Jewelry lists (null = All, the default). */
export const JEWELRY_CATEGORY_CHIPS: { value: JewelryCategory | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'earring', label: 'Earring (ER)' },
  { value: 'stud', label: 'Stud (PS)' },
  { value: 'jhumka', label: 'Jhumka (JK)' },
  { value: 'bracelet', label: 'Bracelet (BR)' },
  { value: 'pendant_set', label: 'Pendant set (PD)' },
  { value: 'other', label: 'Other' },
];

export function isJewelryCategory(v: unknown): v is JewelryCategory {
  return typeof v === 'string' && (v === 'other' || v in JEWELRY_CATEGORY_PREFIX);
}

const ID = 'UPPER(TRIM(item_id))';
const prefixSql = (p: string) => ({ sql: `(${ID} = ? OR ${ID} GLOB ?)`, params: [p, `${p}[^A-Z]*`] });

/** SQL condition (with bound params) selecting one category. */
export function jewelryCategoryWhere(cat: JewelryCategory): { sql: string; params: string[] } {
  if (cat !== 'other') return prefixSql(JEWELRY_CATEGORY_PREFIX[cat]);
  const parts = Object.values(JEWELRY_CATEGORY_PREFIX).map(prefixSql);
  return { sql: `NOT (${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) };
}

/** SQL expression (with bound params) that evaluates to the category name of each row. */
export function jewelryCategoryCaseSql(): { sql: string; params: string[] } {
  const entries = Object.entries(JEWELRY_CATEGORY_PREFIX).map(([cat, p]) => ({ cat, ...prefixSql(p) }));
  return {
    sql: `CASE ${entries.map((e) => `WHEN ${e.sql} THEN '${e.cat}'`).join(' ')} ELSE 'other' END`,
    params: entries.flatMap((e) => e.params),
  };
}
