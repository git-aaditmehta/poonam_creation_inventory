import { useSyncExternalStore } from 'react';

/**
 * Jewelry types (agreed 2026-11-21): a design's type is the LEADING LETTERS of its code, ignoring case and
 * surrounding spaces. "ER 120", "er-5", "ER" → ER (Earring); "ERX 1" is NOT an earring (its letters are ERX).
 * The list lives in the cloud (backend jewelry_categories; the owner adds types in Materials & Categories) and a copy
 * is kept on the phone so chips, filters and Scan work offline. Codes whose letters are not a type are "Other".
 * Same SQL as the server (backend/src/utils/jewelryCategory.ts). Not related to Costing categories.
 */
export interface JewelryType {
  prefix: string;
  name: string;
}

/** Built in (also what the cloud starts with), used until the phone has fetched the list once. */
export const DEFAULT_JEWELRY_TYPES: JewelryType[] = [
  { prefix: 'ER', name: 'Earring' },
  { prefix: 'PS', name: 'Stud' },
  { prefix: 'JK', name: 'Jhumka' },
  { prefix: 'BR', name: 'Bracelet' },
  { prefix: 'PD', name: 'Pendant set' },
  { prefix: 'NK', name: 'Necklace set' },
  { prefix: 'HF', name: 'Half Kada' },
  { prefix: 'HP', name: 'Hathpan' },
  { prefix: 'MP', name: 'Mathapatti' },
  { prefix: 'KD', name: 'Kada' },
  { prefix: 'BG', name: 'Bangles' },
];

const STORE_KEY = 'jewelry_types_v1';
const listeners = new Set<() => void>();

function load(): JewelryType[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (Array.isArray(v) && v.length && v.every((t) => typeof t?.prefix === 'string' && typeof t?.name === 'string')) return v;
  } catch {
    /* no storage: built-in list */
  }
  return DEFAULT_JEWELRY_TYPES;
}
let current: JewelryType[] = load();

export function getJewelryTypes(): JewelryType[] {
  return current;
}

/** Replace the list (from the cloud). Screens using useJewelryTypes() refresh. */
export function setJewelryTypes(types: JewelryType[]): void {
  if (!Array.isArray(types) || types.length === 0) return;
  if (JSON.stringify(types) === JSON.stringify(current)) return;
  current = types;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(types));
  } catch {
    /* kept in memory for this session */
  }
  listeners.forEach((l) => l());
}

export function useJewelryTypes(): JewelryType[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** "Necklace set (NK)" */
export const typeLabel = (t: JewelryType) => `${t.name} (${t.prefix})`;

/** Leading letters of a design code, upper case ("" when it starts with a digit). */
export function leadingLetters(itemId: string | null | undefined): string {
  const m = String(itemId ?? '').trim().match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : '';
}

/** The type of a design code, or null (= Other). */
export function typeOfItemId(itemId: string | null | undefined, types: JewelryType[] = current): JewelryType | null {
  const p = leadingLetters(itemId);
  return (p && types.find((t) => t.prefix === p)) || null;
}

/** Filter value for the chips: a type's letters, or 'other'. */
export type JewelryCategory = string;

const ID = 'UPPER(TRIM(item_id))';
const prefixSql = (p: string) => ({ sql: `(${ID} = ? OR ${ID} GLOB ?)`, params: [p, `${p}[^A-Z]*`] });

/** SQL condition (with bound params) selecting one type (its letters), or 'other' (none of the types). */
export function jewelryCategoryWhere(cat: JewelryCategory, types: JewelryType[] = current): { sql: string; params: string[] } {
  if (cat !== 'other') return prefixSql(cat);
  if (types.length === 0) return { sql: '1 = 1', params: [] };
  const parts = types.map((t) => prefixSql(t.prefix));
  return { sql: `NOT (${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) };
}

/** SQL expression (with bound params) that evaluates to each row's type letters, or 'other'. */
export function jewelryCategoryCaseSql(types: JewelryType[] = current): { sql: string; params: string[] } {
  if (types.length === 0) return { sql: `'other'`, params: [] };
  const entries = types.map((t) => ({ p: t.prefix, ...prefixSql(t.prefix) }));
  return {
    sql: `CASE ${entries.map((e) => `WHEN ${e.sql} THEN ?`).join(' ')} ELSE 'other' END`,
    params: entries.flatMap((e) => [...e.params, e.p]),
  };
}
