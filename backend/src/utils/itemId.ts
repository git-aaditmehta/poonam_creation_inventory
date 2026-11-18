/**
 * Item IDs are the same item when they differ only in capitals, spaces or dashes (agreed 2026-11-19):
 * "PS 365", "ps-365" and "PS365" are ONE item within a category. Plated and Raw may still share an ID
 * (uniqueness is per category table). The ID is stored and shown exactly as typed.
 *
 * ITEM_KEY_SQL and itemKey() must produce the same key; the database enforces it with unique indexes
 * (migrations/0007_item_id_ignore_case_space_dash.sql). Keep frontend/src/utils/itemId.ts identical.
 */
export const ITEM_KEY_SQL = "REPLACE(REPLACE(UPPER(TRIM(item_id)), ' ', ''), '-', '')";

export function itemKey(id: string): string {
  return String(id ?? '').trim().toUpperCase().replace(/[ -]/g, '');
}

/** True when a database error is the unique-ID rule firing (two saves of the same ID at the same moment). */
export function isDuplicateIdError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg) && /item_id|item_key/i.test(msg);
}

export function duplicateIdMessage(typed: string, existing: string | null | undefined, categoryName: string): string {
  const as = existing && existing !== typed.trim() ? ` as "${existing}"` : '';
  return `"${typed.trim()}" already exists${as} in ${categoryName}. IDs that differ only in capitals, spaces or dashes are the same item.`;
}
