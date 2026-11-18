/**
 * Jewelry type from the item ID prefix (leading letters, case-insensitive) — same rule as the DINO scan
 * category. Used by the Plated/Raw Jewelry list filter chips. Keep identical to
 * frontend/src/utils/jewelryCategory.ts (the phone's offline database runs the same SQL).
 */
export type JewelryCategory = 'earring' | 'stud' | 'jhumka' | 'bracelet' | 'pendant_set' | 'other';

const PREFIX: Record<Exclude<JewelryCategory, 'other'>, string> = {
  earring: 'ER',
  stud: 'PS',
  jhumka: 'JK',
  bracelet: 'BR',
  pendant_set: 'PD',
};

export function isJewelryCategory(v: unknown): v is JewelryCategory {
  return typeof v === 'string' && (v === 'other' || v in PREFIX);
}

const ID = 'UPPER(TRIM(item_id))';
const prefixSql = (p: string) => ({ sql: `(${ID} = ? OR ${ID} GLOB ?)`, params: [p, `${p}[^A-Z]*`] });

/** SQL condition (with bound params) selecting one category. */
export function jewelryCategoryWhere(cat: JewelryCategory): { sql: string; params: string[] } {
  if (cat !== 'other') return prefixSql(PREFIX[cat]);
  const parts = Object.values(PREFIX).map(prefixSql);
  return { sql: `NOT (${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) };
}
