/**
 * Item IDs are the same item when they differ only in capitals, spaces or dashes (agreed 2026-11-19):
 * "PS 365", "ps-365" and "PS365" are ONE item within a category. Plated and Raw may still share an ID.
 * Same rule as the server (backend/src/utils/itemId.ts); the phone's database runs the same SQL.
 */
export const ITEM_KEY_SQL = "REPLACE(REPLACE(UPPER(TRIM(item_id)), ' ', ''), '-', '')";

export function itemKey(id: string): string {
  return String(id ?? '').trim().toUpperCase().replace(/[ -]/g, '');
}

/**
 * SQL search on an ID column that also ignores capitals, spaces and dashes: "ps365" finds "PS-365".
 * `column` defaults to item_id. Returns a condition and its parameters.
 */
export function itemIdSearchSql(term: string, column = 'item_id'): { sql: string; params: string[] } {
  const t = term.trim();
  const key = itemKey(t);
  const keyExpr = `REPLACE(REPLACE(UPPER(TRIM(${column})), ' ', ''), '-', '')`;
  if (!key) return { sql: `${column} LIKE ?`, params: [`%${t}%`] };
  return { sql: `(${column} LIKE ? OR ${keyExpr} LIKE ?)`, params: [`%${t}%`, `%${key}%`] };
}
