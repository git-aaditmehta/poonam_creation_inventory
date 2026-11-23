/**
 * Display order of the stock lists (agreed 2026-11-22), so the client sees his stock at one glance:
 *  - Plated / Raw: grouped by jewelry type in the types' order (ER, PS, JK, BR, PD, NK, HF, HP, MP, KD, BG, then any
 *    added later), "Other" last; inside a type the number goes small → big ("PS 2" before "PS 10").
 *  - Kundan Stone: the client's own order (KUNDAN_ORDER below). A new name joins its family (same words, numbers
 *    removed: "7/9 DROP" goes with the DROPs) in ascending number order; a new family comes after the known ones.
 *  - Foil: by weight (stock in kg), lightest first.
 * Front end only: the cloud and the database are unchanged.
 */
import { getJewelryTypes, leadingLetters, type JewelryType } from './jewelryCategory';

// ── Plated / Raw ────────────────────────────────────────────────────────────────────────────────────────────
const firstNumber = (code: string): number => {
  const m = String(code).trim().match(/^[A-Za-z]*[\s-]*(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
};

export function compareJewelryCodes(a: string, b: string, types: JewelryType[] = getJewelryTypes()): number {
  const rank = (code: string) => {
    const i = types.findIndex((t) => t.prefix === leadingLetters(code));
    return i < 0 ? types.length : i; // Other last
  };
  return (
    rank(a) - rank(b) ||
    (rank(a) === types.length ? leadingLetters(a).localeCompare(leadingLetters(b)) : 0) ||
    firstNumber(a) - firstNumber(b) ||
    String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
  );
}

// ── Kundan Stone ────────────────────────────────────────────────────────────────────────────────────────────
/** The client's order (2026-11-22), exactly as given. */
export const KUNDAN_ORDER = [
  '3/5 DROP', '4/6 DROP', '5/7 DROP', '6/8 DROP', '6/9 DROP', '10/15 DROP',
  '3MM ROUND', '4MM ROUND', '5MM ROUND', '6MM ROUND', '7MM ROUND', '8MM ROUND', '10MM ROUND', '17MM ROUND',
  '3/5 OVEL', '4/6 OVEL', '5/7 OVEL', '6/8 OVEL', '8/10 OVEL',
  'OVEL TRIANGLE(FAN)',
  '4/4 SQUARE', '5/5 SQUARE', '6/6 SQUARE',
  '3/6 MARQ', '4/8 MARQ', '5/10 MARQ',
  '3/6 LEAF(R)', '3/6 LEAF(L)', '4/8 LEAF(R)', '4/8 LEAF(L)', '5/10 LEAF(R)', '5/10 LEAF(L)',
  'NEW S(R)', 'NEW S(L)',
  'A6', 'A12', 'A41', 'A42', 'A45', 'A49', 'A52',
  'HATI(R)', 'HATI(L)', 'BELL', 'GHAR', 'Z19', 'Z10',
  'PCJ 2', 'PCJ 5', 'PCJ 8',
  'TAPER(2/3/3)', 'TAPER(4/3/2)', 'TAPER(5/4.5/2)', 'TAPER(4/4/2.5)',
  'BALTI', 'ANDA', 'BIG D', 'SMALL D', 'FAT TS 6/6', 'OCTO SMALL', 'OCTO BIG', 'BIG TRIANGLE',
  'P6', 'P7', 'P8(R)', 'P8(L)', 'P12', 'P13', 'P14', 'P15', 'P21', 'P23', 'P24', 'P25', 'P26', 'P27', 'P28', 'P29', 'P30',
  'AD 1.4',
];

const exactKey = (s: string) => String(s).toUpperCase().replace(/\s+/g, '');
/** Family = the words without numbers, sizes or brackets: "3/6 LEAF(R)" → LEAF, "7MM ROUND" → MMROUND, "P8(L)" → P. */
export const stoneFamily = (s: string) =>
  String(s).toUpperCase().replace(/\([^)]*\)/g, '').replace(/[\d./\s-]+/g, '');
const numbersOf = (s: string) => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);
const sideRank = (s: string) => (/\(R\)\s*$/i.test(s) ? 0 : /\(L\)\s*$/i.test(s) ? 1 : 0);

const EXACT_INDEX = new Map(KUNDAN_ORDER.map((n, i) => [exactKey(n), i]));
const FAMILY_RANK = new Map<string, number>();
KUNDAN_ORDER.forEach((n) => {
  const f = stoneFamily(n);
  if (!FAMILY_RANK.has(f)) FAMILY_RANK.set(f, FAMILY_RANK.size);
});

export function compareStoneNames(a: string, b: string): number {
  const fa = stoneFamily(a);
  const fb = stoneFamily(b);
  const ra = FAMILY_RANK.get(fa) ?? Number.MAX_SAFE_INTEGER;
  const rb = FAMILY_RANK.get(fb) ?? Number.MAX_SAFE_INTEGER;
  if (ra !== rb) return ra - rb;
  if (fa !== fb) return fa.localeCompare(fb); // two new families: alphabetical
  const ia = EXACT_INDEX.get(exactKey(a));
  const ib = EXACT_INDEX.get(exactKey(b));
  if (ia !== undefined && ib !== undefined) return ia - ib; // both in the client's list: exactly his order
  const na = numbersOf(a);
  const nb = numbersOf(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? -1) - (nb[i] ?? -1);
    if (d) return d;
  }
  return sideRank(a) - sideRank(b) || String(a).localeCompare(String(b));
}

// ── All lists ───────────────────────────────────────────────────────────────────────────────────────────────
export function sortInventory<T extends { item_id: string; quantity?: number }>(table: string, rows: T[]): T[] {
  const out = [...rows];
  if (table === 'plated_jewelry' || table === 'raw_jewelry') {
    const types = getJewelryTypes();
    out.sort((x, y) => compareJewelryCodes(x.item_id, y.item_id, types));
  } else if (table === 'stones') {
    out.sort((x, y) => compareStoneNames(x.item_id, y.item_id));
  } else if (table === 'foil') {
    out.sort((x, y) => (Number(x.quantity) || 0) - (Number(y.quantity) || 0) || String(x.item_id).localeCompare(String(y.item_id), undefined, { numeric: true }));
  }
  return out;
}

/**
 * Low Stock (agreed 2026-11-23): Plated, Raw, Kundan Stone, Foil, each sorted exactly as its own section, so a
 * category filter shows its items in the same order as that section.
 */
const SECTION_ORDER = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil'];
export function sortLowStock<T extends { category: string; item_id: string; quantity?: number }>(list: T[]): T[] {
  return [
    ...SECTION_ORDER.flatMap((c) => sortInventory(c, list.filter((i) => i.category === c))),
    ...list.filter((i) => !SECTION_ORDER.includes(i.category)),
  ];
}
