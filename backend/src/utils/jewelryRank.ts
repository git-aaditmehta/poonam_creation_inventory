/**
 * Attribute re-ranking for the Llama + BGE visual search.
 *
 * Why: the canonical text of two different pieces is often word-for-word identical
 * (every "link bracelet, uniform links, white stones" bracelet), so cosine similarity
 * ties at 1.000 and the order is random. This module scores candidates field by field
 * so ties are broken by real information, and known-noisy fields count less.
 *
 * Weights are hand-set from the 2026-11-11 test report; they are meant to be tuned
 * from the per-field accuracy the report now records.
 */
import type { JewelryAttributes } from './jewelryVision';

export const RANK_VERSION = 'rank-v1';

/** Cosine is compressed into ~0.95–1.0 for same-category items; stretch it before mixing. */
const COSINE_FLOOR = 0.8;
/** Share of the final score that comes from attributes (the rest from stretched cosine). */
const ATTRIBUTE_SHARE = 0.65;
/** Two results closer than this are reported as a "close call". */
export const CLOSE_CALL_MARGIN = 0.03;

/** Shapes that the model confuses with each other: count as a near-match. */
const SHAPE_NEIGHBOURS: Record<string, string[]> = {
  round: ['oval', 'flower'],
  oval: ['round', 'teardrop'],
  square: ['rectangle', 'rhombus'],
  rectangle: ['square'],
  rhombus: ['square'],
  teardrop: ['oval', 'leaf'],
  leaf: ['teardrop'],
  half_moon: ['crescent', 'fan'],
  crescent: ['half_moon'],
  fan: ['half_moon'],
  flower: ['round'],
};

const COLOUR_NEIGHBOURS: Record<string, string[]> = {
  red: ['maroon', 'pink'],
  maroon: ['red'],
  pink: ['red'],
  green: ['mint', 'teal'],
  mint: ['green'],
  teal: ['green', 'blue'],
  blue: ['teal'],
  white: ['clear'],
  clear: ['white'],
};

function enumMatch(a: string | undefined, b: string | undefined, neighbours?: Record<string, string[]>): number | null {
  if (!a || !b) return null; // not comparable
  if (a === b) return 1;
  if (neighbours?.[a]?.includes(b)) return 0.5;
  return 0;
}

function boolMatch(a: boolean | undefined, b: boolean | undefined): number | null {
  if (a === undefined || b === undefined) return null;
  return a === b ? 1 : 0;
}

function countMatch(a: number | undefined, b: number | undefined): number | null {
  if (a === undefined || b === undefined) return null;
  if (a === b) return 1;
  const diff = Math.abs(a - b);
  if (diff === 1) return 0.7; // the model miscounts by one often (5 vs 6 bells)
  if (diff === 2) return 0.3;
  return 0;
}

function setMatch(a: string[] | undefined, b: string[] | undefined): number | null {
  if (!a || !b) return null;
  if (a.length === 0 && b.length === 0) return 1;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  // Jaccard with half credit for neighbouring colours
  let near = 0;
  for (const x of A) if (!B.has(x) && COLOUR_NEIGHBOURS[x]?.some((n) => B.has(n))) near += 0.5;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : Math.min(1, (inter + near) / union);
}

export interface RankOptions {
  /** True when the user picked a category chip (category is then certain, not a guess). */
  categoryCertain: boolean;
}

export interface FieldScore {
  weight: number;
  match: number; // 0..1
}

export interface AttributeScore {
  /** 0..1 weighted agreement over the fields present on both sides; null if nothing comparable. */
  score: number | null;
  breakdown: Record<string, FieldScore>;
}

/**
 * Weighted field agreement. Fields missing on either side are skipped (not penalised),
 * so an old v1 vector without attributes simply gets score null.
 */
export function scoreAttributes(q: JewelryAttributes, cand: JewelryAttributes, opts: RankOptions): AttributeScore {
  const fields: [string, number, number | null][] = [
    // Category is only a guess when no chip was chosen: a stud read as "pendant" must not sink the studs
    ['category', opts.categoryCertain ? 0 : 1.0, enumMatch(q.category, cand.category)],
    ['structure', 2.5, enumMatch(q.structure, cand.structure)],
    ['stone_layout', 2.0, enumMatch(q.stone_layout, cand.stone_layout)],
    ['enamel_color', 2.0, enumMatch(q.enamel_color, cand.enamel_color)],
    ['outline_shape', 1.5, enumMatch(q.outline_shape, cand.outline_shape, SHAPE_NEIGHBOURS)],
    ['accent_colors', 1.5, setMatch(q.accent_colors, cand.accent_colors)],
    ['jhumka_count', 1.5, countMatch(q.jhumka_count, cand.jhumka_count)],
    // "none" vs a colour is usually the model deciding whether a centre exists, not a real difference
    [
      'center_stone_color',
      1.5,
      q.center_stone_color === 'none' || cand.center_stone_color === 'none'
        ? q.center_stone_color === cand.center_stone_color
          ? 1
          : 0.5
        : enumMatch(q.center_stone_color, cand.center_stone_color, COLOUR_NEIGHBOURS),
    ],
    ['center_stone_shape', 1.0, enumMatch(q.center_stone_shape, cand.center_stone_shape, SHAPE_NEIGHBOURS)],
    ['has_cz_border', 0.75, boolMatch(q.has_cz_border, cand.has_cz_border)],
    ['has_pearls', 0.75, boolMatch(q.has_pearls, cand.has_pearls)],
    ['has_hanging_beads', 0.75, boolMatch(q.has_hanging_beads, cand.has_hanging_beads)],
    ['motif', 0.5, enumMatch(q.motif, cand.motif)], // flips often (floral vs none)
    ['main_stone_type', 0.5, enumMatch(q.main_stone_type, cand.main_stone_type)],
    ['metal_tone', 0.5, enumMatch(q.metal_tone, cand.metal_tone)],
  ];

  const breakdown: Record<string, FieldScore> = {};
  let sumW = 0;
  let sum = 0;
  for (const [name, weight, match] of fields) {
    if (match === null || weight === 0) continue;
    breakdown[name] = { weight, match };
    sumW += weight;
    sum += weight * match;
  }
  return { score: sumW > 0 ? sum / sumW : null, breakdown };
}

export function stretchCosine(cosine: number): number {
  return Math.max(0, Math.min(1, (cosine - COSINE_FLOOR) / (1 - COSINE_FLOOR)));
}

/** Final score 0..1. Without attributes (old vector) it is the stretched cosine alone. */
export function finalScore(cosine: number, attributeScore: number | null): number {
  const c = stretchCosine(cosine);
  if (attributeScore === null) return c;
  return (1 - ATTRIBUTE_SHARE) * c + ATTRIBUTE_SHARE * attributeScore;
}
