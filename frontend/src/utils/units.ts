import type { InventoryUnit } from '../types';

/** Units the owner can choose for Plated and Raw Jewelry (Stones are fixed to PC, Foil to KGS). */
export const SELECTABLE_UNITS: InventoryUnit[] = ['PC', 'KGS', 'SET', 'JODI', 'GRMS'];

/** Spellings found in Excel sheets → the unit stored in the app. Matching ignores case, spaces and dots. */
const UNIT_ALIASES: Record<string, InventoryUnit> = {
  PC: 'PC',
  KGS: 'KGS',
  KG: 'KGS',
  SET: 'SET',
  JODI: 'JODI',
  GRMS: 'GRMS',
  GRM: 'GRMS',
  GMS: 'GRMS',
  GM: 'GRMS',
  GRAM: 'GRMS',
  GRAMS: 'GRMS',
  G: 'GRMS',
};

/** Recognised unit for a raw Excel value, or null if it is not one we know. */
export function normalizeUnit(raw: unknown): InventoryUnit | null {
  const key = String(raw ?? '').toUpperCase().replace(/[\s.]/g, '');
  return UNIT_ALIASES[key] ?? null;
}
