/**
 * Jewelry Vision Pipeline (v3 — strict JSON attributes, category-specific questions)
 *
 * Single source of truth for the image → attributes → text → 384-dim vector pipeline.
 * Used by: search (phone photos), single-item embed, backfill, and auto-embed on upload.
 * Catalog and query photos MUST go through the exact same prompt + text builder,
 * otherwise their vectors are not comparable.
 *
 *   Step 1: Llama 3.2 Vision → strict JSON with a fixed vocabulary (temperature 0).
 *           When the category is known (SKU prefix / chip) the prompt asks only that
 *           category's questions; otherwise it asks the model to pick the category and
 *           answer that category's block.
 *   Step 2: Code validates/normalizes the JSON (unknown values are dropped)
 *   Step 3: Code builds a canonical, fixed-order text from the fields
 *   Step 4: BGE-small embeds that text → 384-dim vector
 *
 * Pendant sets get a second vector for their matching earrings (id `<uuid>#earring`),
 * so a scan of only the earrings still finds the set.
 *
 * v3 adds per-category fields (bracelet band/rows/segments, jhumka dome/rim, stud border/
 * surround, earring tiers/top/drops) because v2 produced word-for-word identical texts for
 * different pieces of the same type, which tied every score at 1.000.
 */

export const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
export const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
export const VECTOR_DIMENSIONS = 384;
export const PROMPT_VERSION = 'v3-json-1';

const VISION_MAX_TOKENS = 600; // ~22 fields (+ earrings block for sets) ≈ 250–400 tokens; headroom avoids truncation
const RETRY_TEMPERATURE = 0.3; // retrying at temperature 0 would return the same broken output

/** Suffix of the secondary vector that describes a pendant set's matching earrings. */
export const EARRING_COMPONENT_SUFFIX = '#earring';
export const parentIdOf = (vectorId: string) => vectorId.split('#')[0];

// ─── Vocabulary ───────────────────────────────────────────────────────

export const CATEGORIES = ['earring', 'stud', 'jhumka', 'bracelet', 'pendant_set', 'necklace', 'other'] as const;
export type JewelryCategory = (typeof CATEGORIES)[number];

/** Categories the user can pick on the scan screen (match SKU prefixes). */
export const FILTERABLE_CATEGORIES: JewelryCategory[] = ['earring', 'stud', 'jhumka', 'bracelet', 'pendant_set'];

const SKU_PREFIX_CATEGORY: Record<string, JewelryCategory> = {
  ER: 'earring',
  PS: 'stud',
  JK: 'jhumka',
  BR: 'bracelet',
  PD: 'pendant_set',
};

const STRUCTURES = [
  'single_motif', 'motif_with_jhumka', 'chandbali', 'chandbali_with_jhumka',
  'multi_tier_drop', 'multi_jhumka_drop', 'dome', 'link_bracelet', 'other',
] as const;
const SHAPES = [
  'round', 'oval', 'square', 'rectangle', 'hexagon', 'rhombus', 'teardrop', 'heart',
  'half_moon', 'crescent', 'fan', 'triangle', 'flower', 'leaf', 'irregular',
] as const;
const METAL_TONES = ['yellow_gold', 'rose_gold', 'antique_gold', 'silver'] as const;
const STONE_TYPES = ['kundan', 'cz', 'polki', 'pearl', 'none'] as const;
const COLORS = ['white', 'red', 'pink', 'green', 'mint', 'blue', 'purple', 'none'] as const;
const STONE_SHAPES = ['round', 'oval', 'square', 'teardrop', 'marquise', 'heart', 'irregular', 'none'] as const;
const ACCENT_COLORS = ['red', 'pink', 'green', 'mint', 'blue', 'purple', 'pearl', 'maroon_bead'] as const;
const ENAMEL_COLORS = ['none', 'white', 'green', 'mint', 'grey', 'pink', 'blue', 'red'] as const;
const LAYOUTS = [
  'single_center', 'center_with_ring', 'petal_flower', 'rows_grid',
  'border_ring', 'scattered_cluster', 'lattice', 'uniform_links',
] as const;
const MOTIFS = ['floral', 'leaf', 'peacock', 'elephant', 'paisley', 'geometric', 'filigree', 'none'] as const;

// Category-specific vocabularies (v3)
const BAND_TYPES = ['chain', 'flexible_links', 'rigid_band', 'cuff'] as const;
const WIDTHS = ['thin', 'medium', 'wide'] as const;
const SEGMENT_SHAPES = ['round', 'oval', 'square', 'rectangle', 'flower', 'leaf', 'paisley', 'mixed'] as const;
const SIZES = ['small', 'medium', 'large'] as const;
const SPACINGS = ['dense', 'spaced'] as const;
const DOME_PATTERNS = ['floral', 'petal_rows', 'lattice', 'leaf', 'plain'] as const;
const RIM_STYLES = ['plain', 'beaded', 'hanging_beads', 'pearls'] as const;
const CAP_STYLES = ['none', 'plain', 'stone', 'floral'] as const;
const BORDER_STYLES = ['plain', 'cz_line', 'beaded', 'rays', 'petals'] as const;
const TOP_MOTIFS = ['stud', 'flower', 'leaf', 'peacock', 'paisley', 'crescent', 'teardrop', 'none'] as const;
const DROP_TYPES = ['none', 'beads', 'pearls', 'bells', 'stones'] as const;
const EARRING_TYPES = ['stud', 'hanging'] as const;

/** Common words Llama uses instead of our vocabulary → canonical value. */
const SYNONYMS: Record<string, string> = {
  circle: 'round', circular: 'round', disc: 'round',
  ellipse: 'oval', elliptical: 'oval',
  diamond_shape: 'rhombus', diamond_shaped: 'rhombus', kite: 'rhombus',
  hexagonal: 'hexagon', drop: 'teardrop', pear: 'teardrop',
  semicircle: 'half_moon', semi_circle: 'half_moon', half_circle: 'half_moon', moon: 'crescent',
  gold: 'yellow_gold', gold_plated: 'yellow_gold', yellow: 'yellow_gold',
  rose: 'rose_gold', antique: 'antique_gold', matte_gold: 'antique_gold',
  ruby: 'red', maroon: 'red', magenta: 'pink', emerald: 'green', turquoise: 'mint', aqua: 'mint',
  sapphire: 'blue', clear: 'white', transparent: 'white', crystal: 'white', diamond: 'white', colorless: 'white',
  gray: 'grey', american_diamond: 'cz', ad: 'cz', zircon: 'cz',
  chandelier: 'multi_tier_drop', drop_earring: 'multi_tier_drop',
  links: 'flexible_links', link: 'flexible_links', flexible: 'flexible_links', bangle: 'rigid_band', rigid: 'rigid_band', kada: 'rigid_band',
  narrow: 'thin', broad: 'wide', big: 'large', tiny: 'small',
  close: 'dense', tight: 'dense', gap: 'spaced', gaps: 'spaced', sparse: 'spaced',
  petal: 'petal_rows', petals: 'petals', beads: 'beaded', bead: 'beaded', pearl: 'pearls',
  chand: 'crescent', dangling: 'hanging', hanging_earring: 'hanging',
};

/** Attributes of a pendant set's matching earrings (a reduced common block). */
export interface EarringComponent {
  type?: string; // stud | hanging
  outline_shape?: string;
  center_stone_color?: string;
  center_stone_shape?: string;
  enamel_color?: string;
  stone_layout?: string;
  jhumka_count?: number;
  has_cz_border?: boolean;
  has_pearls?: boolean;
}

export interface JewelryAttributes {
  is_jewelry: boolean;
  category?: JewelryCategory;
  structure?: string;
  outline_shape?: string;
  metal_tone?: string;
  main_stone_type?: string;
  center_stone_color?: string;
  center_stone_shape?: string;
  accent_colors?: string[];
  enamel_color?: string;
  stone_layout?: string;
  motif?: string;
  jhumka_count?: number;
  has_pearls?: boolean;
  has_hanging_beads?: boolean;
  has_cz_border?: boolean;
  // bracelet
  band_type?: string;
  band_width?: string;
  row_count?: number;
  segment_shape?: string;
  segment_count?: number;
  stone_size?: string;
  spacing?: string;
  // jhumka
  dome_pattern?: string;
  rim_style?: string;
  dome_size?: string;
  cap_style?: string;
  // stud
  border_style?: string;
  surround_count?: number;
  stone_count?: number;
  // earring
  tier_count?: number;
  top_motif?: string;
  has_crescent?: boolean;
  drop_type?: string;
  drop_count?: number;
  // pendant set
  has_chain?: boolean;
  matching_earrings?: EarringComponent;
}

// ─── Prompt ───────────────────────────────────────────────────────────

const COMMON_FIELDS = `  "is_jewelry": true | false,
  "category": "earring" | "stud" | "jhumka" | "bracelet" | "pendant_set" | "necklace" | "other",
  "structure": "single_motif" | "motif_with_jhumka" | "chandbali" | "chandbali_with_jhumka" | "multi_tier_drop" | "multi_jhumka_drop" | "dome" | "link_bracelet" | "other",
  "outline_shape": "round" | "oval" | "square" | "rectangle" | "hexagon" | "rhombus" | "teardrop" | "heart" | "half_moon" | "crescent" | "fan" | "triangle" | "flower" | "leaf" | "irregular",
  "metal_tone": "yellow_gold" | "rose_gold" | "antique_gold" | "silver",
  "main_stone_type": "kundan" | "cz" | "polki" | "pearl" | "none",
  "center_stone_color": "white" | "red" | "pink" | "green" | "mint" | "blue" | "purple" | "none",
  "center_stone_shape": "round" | "oval" | "square" | "teardrop" | "marquise" | "heart" | "irregular" | "none",
  "accent_colors": [zero or more of "red", "pink", "green", "mint", "blue", "purple", "pearl", "maroon_bead"],
  "enamel_color": "none" | "white" | "green" | "mint" | "grey" | "pink" | "blue" | "red",
  "stone_layout": "single_center" | "center_with_ring" | "petal_flower" | "rows_grid" | "border_ring" | "scattered_cluster" | "lattice" | "uniform_links",
  "motif": "floral" | "leaf" | "peacock" | "elephant" | "paisley" | "geometric" | "filigree" | "none",
  "jhumka_count": number of bell-shaped jhumka drops hanging from ONE piece (0 if none),
  "has_pearls": true | false,
  "has_hanging_beads": true | false,
  "has_cz_border": true | false`;

const CATEGORY_FIELDS: Record<JewelryCategory, string> = {
  bracelet: `  "band_type": "chain" | "flexible_links" | "rigid_band" | "cuff",
  "band_width": "thin" | "medium" | "wide",
  "row_count": number of parallel rows of stones along the band (1, 2, 3...),
  "segment_shape": "round" | "oval" | "square" | "rectangle" | "flower" | "leaf" | "paisley" | "mixed",
  "segment_count": number of repeating segments/links along the band (0 if one continuous band),
  "stone_size": "small" | "medium" | "large",
  "spacing": "dense" | "spaced"`,
  jhumka: `  "dome_pattern": "floral" | "petal_rows" | "lattice" | "leaf" | "plain",
  "rim_style": "plain" | "beaded" | "hanging_beads" | "pearls",
  "dome_size": "small" | "medium" | "large",
  "cap_style": "none" | "plain" | "stone" | "floral"`,
  stud: `  "border_style": "plain" | "cz_line" | "beaded" | "rays" | "petals",
  "surround_count": number of stones arranged around the centre stone (0 if none),
  "stone_count": total number of visible stones on ONE stud`,
  earring: `  "tier_count": number of stacked parts from the ear down to the bottom (1 to 5),
  "top_motif": "stud" | "flower" | "leaf" | "peacock" | "paisley" | "crescent" | "teardrop" | "none",
  "has_crescent": true | false (a chand / half-moon frame anywhere in the earring),
  "drop_type": "none" | "beads" | "pearls" | "bells" | "stones",
  "drop_count": number of small drops hanging along the bottom edge (0 if none)`,
  pendant_set: `  "has_chain": true | false,
  "matching_earrings": {
    "type": "stud" | "hanging",
    "outline_shape": same values as above,
    "center_stone_color": same values as above,
    "center_stone_shape": same values as above,
    "enamel_color": same values as above,
    "stone_layout": same values as above,
    "jhumka_count": number,
    "has_cz_border": true | false,
    "has_pearls": true | false
  }`,
  necklace: '',
  other: '',
};

const CATEGORY_DEFINITIONS: Record<JewelryCategory, string> = {
  bracelet: `- Fill the common fields for the band as a whole: center_stone_color = the dominant stone colour of the band, outline_shape = shape of ONE segment.
- band_type: chain = thin links with gaps; flexible_links = segments joined edge to edge; rigid_band = one solid curved band; cuff = rigid with an opening.`,
  jhumka: `- A jhumka is a bell/dome. structure is "dome". outline_shape is "round".
- dome_pattern describes how the stones are arranged on the dome; rim_style describes the bottom edge of the dome.
- The photo may show 4 separate domes: they are 4 copies, NOT one piece. Describe one dome.`,
  stud: `- A stud is one flat motif with no hanging parts.
- surround_count: count the stones placed in a ring/petals around the centre stone. stone_count: all visible stones on one stud.
- border_style: what runs along the outer edge (plain metal, a cz line, beads, metal rays, or stone petals).`,
  earring: `- A hanging earring has a top part at the ear plus one or more parts below.
- tier_count: how many stacked parts from the ear to the bottom (top motif = 1, a chandbali below it = 2, a jhumka below that = 3).
- has_crescent: true if any part is a chand / half-moon shaped frame. drop_count: small drops along the bottom edge (beads, pearls, tiny bells).`,
  pendant_set: `- A pendant set is a pendant (sometimes on a chain) shown with matching earrings.
- Fill the common fields for the PENDANT only. Fill "matching_earrings" for ONE of the earrings.`,
  necklace: '',
  other: '',
};

const RULES = `Rules:
1. IGNORE any printed text, numbers, codes, labels or red writing in the photo. Never mention them.
2. IGNORE the background, paper, cloth, earring stand, hands and shadows.
3. The photo may show 2, 4 or more identical copies laid out separately. They are copies, NOT links or parts of one piece. Describe ONE single piece.
4. center_stone_color: colour of the single largest/central stone; if there is no centre stone, the dominant stone colour. accent_colors: other coloured stones, plus "pearl" or "maroon_bead" if present. White/clear stones are not accents.
5. has_cz_border: a continuous line of tiny sparkling stones along an edge. chandbali: a crescent / half-moon shaped hanging frame.
6. If the object is not jewelry (for example a watch, phone, coin, tool or random object), set "is_jewelry": false.
7. Reply with the JSON object ONLY. No explanation, no markdown, no text before or after.`;

const GENERIC_DEFINITIONS = `Category definitions:
- stud: one flat motif worn on the ear, no hanging parts (small).
- earring: a hanging earring with several parts (top motif plus drops, chandbali or jhumka).
- jhumka: a loose bell/dome-shaped jhumka piece on its own (often 4 copies shown).
- bracelet: a band, chain or links worn on the wrist (long and narrow).
- pendant_set: a pendant, usually shown with matching small earrings.`;

/**
 * Prompt for one category (known from the SKU prefix or the chip), or a generic prompt
 * that asks the model to pick the category and answer only that category's block.
 */
export function buildVisionPrompt(knownCategory: JewelryCategory | null): string {
  const head = `You are an expert cataloguer of Indian gold-plated kundan jewelry. Look at the photo and fill in this JSON. Use ONLY the allowed values listed after each key.`;
  if (knownCategory && CATEGORY_FIELDS[knownCategory]) {
    return `${head}
This photo shows a ${knownCategory.replace('_', ' ')}. Set "category": "${knownCategory}".

{
${COMMON_FIELDS},
${CATEGORY_FIELDS[knownCategory]}
}

Definitions:
${CATEGORY_DEFINITIONS[knownCategory]}

${RULES}`;
  }
  const blocks = FILTERABLE_CATEGORIES.map(
    (cat) => `If category is "${cat}", ALSO include:
${CATEGORY_FIELDS[cat]}`
  ).join('\n\n');
  return `${head}
First decide the category, then answer the common fields AND the extra fields for that category only.

Common fields:
{
${COMMON_FIELDS}
}

${blocks}

${GENERIC_DEFINITIONS}

${FILTERABLE_CATEGORIES.map((cat) => CATEGORY_DEFINITIONS[cat]).join('\n')}

${RULES}`;
}

/** Kept for compatibility (generic prompt). */
export const JEWELRY_JSON_PROMPT = buildVisionPrompt(null);

// ─── Helpers ──────────────────────────────────────────────────────────

export function categoryFromItemId(itemId: string | null | undefined): JewelryCategory {
  const match = (itemId || '').trim().match(/^([A-Za-z]+)/);
  if (!match) return 'other';
  return SKU_PREFIX_CATEGORY[match[1].toUpperCase()] || 'other';
}

export function isFilterableCategory(value: unknown): value is JewelryCategory {
  return typeof value === 'string' && (FILTERABLE_CATEGORIES as string[]).includes(value);
}

export function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Narrow on purpose: a bare "limit" also matches unrelated errors (e.g. image size limits)
  return /quota|429|rate.?limit|daily free allocation|neurons/i.test(msg);
}

function normToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function pickEnum(value: unknown, allowed: readonly string[]): string | undefined {
  const token = normToken(value);
  if (!token) return undefined;
  if (allowed.includes(token)) return token;
  const synonym = SYNONYMS[token];
  if (synonym && allowed.includes(synonym)) return synonym;
  return undefined;
}

function pickBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const token = normToken(value);
  if (['true', 'yes', '1'].includes(token)) return true;
  if (['false', 'no', '0'].includes(token)) return false;
  return undefined;
}

function pickCount(value: unknown, max = 9): number | undefined {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(max, Math.round(n)));
}

/** Extract a JSON object from model output that may contain fences, prose or trailing commas. */
function extractJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try next repair */
    }
  }
  return null;
}

/** Remove keys whose value is undefined, so JSON/metadata stay compact and comparisons are clean. */
function compact<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) if (obj[k] === undefined) delete obj[k];
  return obj;
}

function normalizeEarringComponent(raw: unknown): EarringComponent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const comp = compact<EarringComponent>({
    type: pickEnum(o.type, EARRING_TYPES),
    outline_shape: pickEnum(o.outline_shape, SHAPES),
    center_stone_color: pickEnum(o.center_stone_color, COLORS),
    center_stone_shape: pickEnum(o.center_stone_shape, STONE_SHAPES),
    enamel_color: pickEnum(o.enamel_color, ENAMEL_COLORS),
    stone_layout: pickEnum(o.stone_layout, LAYOUTS),
    jhumka_count: pickCount(o.jhumka_count),
    has_cz_border: pickBool(o.has_cz_border),
    has_pearls: pickBool(o.has_pearls),
  });
  return Object.keys(comp).length ? comp : undefined;
}

/**
 * Validate + normalize raw model JSON into our fixed vocabulary. Unknown values are dropped.
 * Category-specific fields are kept only for the final category, so a stray bracelet field on
 * an earring never leaks into the text.
 */
export function normalizeAttributes(obj: Record<string, unknown>, categoryOverride?: JewelryCategory): JewelryAttributes {
  const accents = Array.isArray(obj.accent_colors)
    ? obj.accent_colors
    : typeof obj.accent_colors === 'string'
      ? String(obj.accent_colors).split(/[,/]/)
      : [];
  const accentColors = Array.from(
    new Set(accents.map((a) => pickEnum(a, ACCENT_COLORS)).filter((a): a is string => Boolean(a)))
  ).sort();

  const attrs: JewelryAttributes = {
    is_jewelry: pickBool(obj.is_jewelry) ?? true,
    category: pickEnum(obj.category, CATEGORIES) as JewelryCategory | undefined,
    structure: pickEnum(obj.structure, STRUCTURES),
    outline_shape: pickEnum(obj.outline_shape, SHAPES),
    metal_tone: pickEnum(obj.metal_tone, METAL_TONES),
    main_stone_type: pickEnum(obj.main_stone_type, STONE_TYPES),
    center_stone_color: pickEnum(obj.center_stone_color, COLORS),
    center_stone_shape: pickEnum(obj.center_stone_shape, STONE_SHAPES),
    accent_colors: accentColors,
    enamel_color: pickEnum(obj.enamel_color, ENAMEL_COLORS),
    stone_layout: pickEnum(obj.stone_layout, LAYOUTS),
    motif: pickEnum(obj.motif, MOTIFS),
    jhumka_count: pickCount(obj.jhumka_count),
    has_pearls: pickBool(obj.has_pearls),
    has_hanging_beads: pickBool(obj.has_hanging_beads),
    has_cz_border: pickBool(obj.has_cz_border),
  };
  // The model sometimes repeats the centre stone colour as an accent and sometimes doesn't;
  // drop it so catalog and phone descriptions of the same piece produce the same text.
  if (attrs.center_stone_color && attrs.accent_colors) {
    attrs.accent_colors = attrs.accent_colors.filter((c) => c !== attrs.center_stone_color);
  }

  const category = categoryOverride ?? attrs.category;
  switch (category) {
    case 'bracelet':
      Object.assign(attrs, {
        band_type: pickEnum(obj.band_type, BAND_TYPES),
        band_width: pickEnum(obj.band_width, WIDTHS),
        row_count: pickCount(obj.row_count, 6),
        segment_shape: pickEnum(obj.segment_shape, SEGMENT_SHAPES),
        segment_count: pickCount(obj.segment_count, 40),
        stone_size: pickEnum(obj.stone_size, SIZES),
        spacing: pickEnum(obj.spacing, SPACINGS),
      });
      break;
    case 'jhumka':
      Object.assign(attrs, {
        dome_pattern: pickEnum(obj.dome_pattern, DOME_PATTERNS),
        rim_style: pickEnum(obj.rim_style, RIM_STYLES),
        dome_size: pickEnum(obj.dome_size, SIZES),
        cap_style: pickEnum(obj.cap_style, CAP_STYLES),
      });
      break;
    case 'stud':
      Object.assign(attrs, {
        border_style: pickEnum(obj.border_style, BORDER_STYLES),
        surround_count: pickCount(obj.surround_count, 24),
        stone_count: pickCount(obj.stone_count, 60),
      });
      break;
    case 'earring':
      Object.assign(attrs, {
        tier_count: pickCount(obj.tier_count, 5),
        top_motif: pickEnum(obj.top_motif, TOP_MOTIFS),
        has_crescent: pickBool(obj.has_crescent),
        drop_type: pickEnum(obj.drop_type, DROP_TYPES),
        drop_count: pickCount(obj.drop_count, 30),
      });
      break;
    case 'pendant_set':
      Object.assign(attrs, {
        has_chain: pickBool(obj.has_chain),
        matching_earrings: normalizeEarringComponent(obj.matching_earrings),
      });
      break;
    default:
      break;
  }
  return compact(attrs);
}

const CATEGORY_PHRASE: Record<JewelryCategory, string> = {
  earring: 'hanging drop earring',
  stud: 'stud earring',
  jhumka: 'jhumka dome bell',
  bracelet: 'bracelet',
  pendant_set: 'pendant',
  necklace: 'necklace',
  other: 'jewelry piece',
};

const words = (token: string) => token.replace(/_/g, ' ');

/**
 * Canonical embedding text. Fixed order, most discriminative facts first,
 * only positive facts (repeating "no enamel" on most items would add shared noise).
 */
export function buildEmbeddingText(a: JewelryAttributes): string {
  const parts: string[] = [];
  parts.push(CATEGORY_PHRASE[a.category || 'other']);
  if (a.structure && a.structure !== 'other') parts.push(`${words(a.structure)} structure`);
  if (a.outline_shape) parts.push(`${words(a.outline_shape)} outline`);
  if (a.center_stone_color && a.center_stone_color !== 'none') {
    const shape = a.center_stone_shape && a.center_stone_shape !== 'none' ? ` ${words(a.center_stone_shape)}` : '';
    parts.push(`${a.center_stone_color}${shape} center stone`);
  }
  if (a.accent_colors && a.accent_colors.length) parts.push(`${a.accent_colors.map(words).join(' and ')} accents`);
  if (a.enamel_color && a.enamel_color !== 'none') parts.push(`${a.enamel_color} meenakari enamel`);
  if (a.jhumka_count && a.jhumka_count > 0) parts.push(`${a.jhumka_count} jhumka bell${a.jhumka_count > 1 ? 's' : ''}`);
  if (a.stone_layout) parts.push(`${words(a.stone_layout)} stone layout`);

  // Category-specific facts (v3)
  if (a.band_type) parts.push(`${words(a.band_type)} band`);
  if (a.band_width) parts.push(`${a.band_width} width`);
  if (a.row_count) parts.push(`${a.row_count} row${a.row_count > 1 ? 's' : ''} of stones`);
  if (a.segment_shape) parts.push(`${a.segment_shape} segments`);
  if (a.segment_count) parts.push(`${a.segment_count} segments`);
  if (a.stone_size) parts.push(`${a.stone_size} stones`);
  if (a.spacing) parts.push(`${a.spacing} spacing`);
  if (a.dome_pattern) parts.push(`${words(a.dome_pattern)} dome pattern`);
  if (a.rim_style && a.rim_style !== 'plain') parts.push(`${words(a.rim_style)} rim`);
  if (a.dome_size) parts.push(`${a.dome_size} dome`);
  if (a.cap_style && a.cap_style !== 'none') parts.push(`${a.cap_style} cap`);
  if (a.border_style && a.border_style !== 'plain') parts.push(`${words(a.border_style)} border`);
  if (a.surround_count) parts.push(`${a.surround_count} surrounding stones`);
  if (a.stone_count) parts.push(`${a.stone_count} stones total`);
  if (a.tier_count) parts.push(`${a.tier_count} tier${a.tier_count > 1 ? 's' : ''}`);
  if (a.top_motif && a.top_motif !== 'none') parts.push(`${a.top_motif} top`);
  if (a.has_crescent) parts.push('crescent chand frame');
  if (a.drop_type && a.drop_type !== 'none') parts.push(`${a.drop_count ? `${a.drop_count} ` : ''}${a.drop_type} drops`);
  if (a.has_chain) parts.push('with chain');

  if (a.main_stone_type && a.main_stone_type !== 'none') parts.push(`${a.main_stone_type} stones`);
  if (a.motif && a.motif !== 'none') parts.push(`${a.motif} motif`);
  if (a.has_pearls) parts.push('pearls');
  if (a.has_hanging_beads) parts.push('hanging beads');
  if (a.has_cz_border) parts.push('cz stone border');
  if (a.metal_tone) parts.push(words(a.metal_tone));
  return parts.join('. ') + '.';
}

/** Turn a set's matching-earrings block into standalone earring/stud attributes (for its own vector). */
export function earringComponentAttributes(set: JewelryAttributes): JewelryAttributes | null {
  const e = set.matching_earrings;
  if (!e) return null;
  const isStud = e.type !== 'hanging';
  return compact<JewelryAttributes>({
    is_jewelry: true,
    category: isStud ? 'stud' : 'earring',
    structure: isStud ? 'single_motif' : e.jhumka_count ? 'motif_with_jhumka' : 'multi_tier_drop',
    outline_shape: e.outline_shape,
    metal_tone: set.metal_tone,
    main_stone_type: set.main_stone_type,
    center_stone_color: e.center_stone_color,
    center_stone_shape: e.center_stone_shape,
    accent_colors: set.accent_colors,
    enamel_color: e.enamel_color ?? set.enamel_color,
    stone_layout: e.stone_layout,
    jhumka_count: e.jhumka_count,
    has_pearls: e.has_pearls,
    has_cz_border: e.has_cz_border,
  });
}

// ─── Pipeline ─────────────────────────────────────────────────────────

export interface PipelineTelemetry {
  vision_ms: number;
  embedding_ms: number;
  total_ms: number;
  image_bytes: number;
  vision_attempts: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  description_length: number;
  vector_dimensions: number;
  vision_model: string;
  embedding_model: string;
  prompt_version: string;
}

export interface PipelineResult {
  ok: boolean;
  error: string | null;
  quotaExhausted: boolean;
  attributes: JewelryAttributes | null;
  /** What the model itself thought the category was, before any chip/SKU override. */
  aiCategoryGuess: JewelryCategory | null;
  embeddingText: string | null;
  rawVisionOutput: string | null;
  vector: number[] | null;
  telemetry: PipelineTelemetry;
}

export interface AnalyzeOptions {
  /** Override the AI's category (catalog: from SKU prefix; query: from user's category chip). */
  categoryOverride?: JewelryCategory;
  /** Catalog images are always jewelry; ignore an `is_jewelry: false` mistake. */
  forceJewelry?: boolean;
}

async function runVision(ai: any, imageBytes: Uint8Array, prompt: string, temperature: number) {
  const result = await ai.run(VISION_MODEL, {
    image: [...imageBytes],
    prompt,
    max_tokens: VISION_MAX_TOKENS,
    temperature,
  });
  const response = result?.response ?? (typeof result === 'string' ? result : null);
  return {
    response,
    rawText: typeof response === 'string' ? response : response ? JSON.stringify(response) : '',
    promptTokens: typeof result?.usage?.prompt_tokens === 'number' ? result.usage.prompt_tokens : null,
    completionTokens: typeof result?.usage?.completion_tokens === 'number' ? result.usage.completion_tokens : null,
  };
}

async function embedText(ai: any, text: string): Promise<number[]> {
  const result = await ai.run(EMBEDDING_MODEL, { text: [text] });
  const vector = result?.data?.[0] as number[] | undefined;
  if (!vector) throw new Error('Embedding model returned empty vector');
  if (vector.length !== VECTOR_DIMENSIONS) throw new Error(`Unexpected dimensions: ${vector.length} (expected ${VECTOR_DIMENSIONS})`);
  return vector;
}

/** Full pipeline: image bytes → validated attributes → canonical text → 384-dim vector. */
export async function analyzeJewelryImage(
  ai: any,
  imageBytes: Uint8Array,
  options: AnalyzeOptions = {}
): Promise<PipelineResult> {
  const start = Date.now();
  const telemetry: PipelineTelemetry = {
    vision_ms: 0,
    embedding_ms: 0,
    total_ms: 0,
    image_bytes: imageBytes.length,
    vision_attempts: 0,
    prompt_tokens: null,
    completion_tokens: null,
    description_length: 0,
    vector_dimensions: 0,
    vision_model: VISION_MODEL,
    embedding_model: EMBEDDING_MODEL,
    prompt_version: PROMPT_VERSION,
  };
  const fail = (error: string, quotaExhausted = false, extra: Partial<PipelineResult> = {}): PipelineResult => {
    telemetry.total_ms = Date.now() - start;
    return {
      ok: false, error, quotaExhausted, attributes: null, aiCategoryGuess: null, embeddingText: null,
      rawVisionOutput: null, vector: null, telemetry, ...extra,
    };
  };

  // Step 1: Vision → JSON (one retry at a higher temperature if the JSON is unusable)
  const prompt = buildVisionPrompt(options.categoryOverride ?? null);
  let parsed: Record<string, unknown> | null = null;
  let rawVisionOutput = '';
  const visionStart = Date.now();
  for (const temperature of [0, RETRY_TEMPERATURE]) {
    telemetry.vision_attempts++;
    try {
      const out = await runVision(ai, imageBytes, prompt, temperature);
      rawVisionOutput = out.rawText;
      if (out.promptTokens !== null) telemetry.prompt_tokens = (telemetry.prompt_tokens ?? 0) + out.promptTokens;
      if (out.completionTokens !== null) {
        telemetry.completion_tokens = (telemetry.completion_tokens ?? 0) + out.completionTokens;
      }
      parsed = extractJsonObject(out.response);
      if (parsed) break;
      console.warn(`[JewelryVision] Unparseable vision output (attempt ${telemetry.vision_attempts}): ${rawVisionOutput.slice(0, 200)}`);
    } catch (err) {
      telemetry.vision_ms = Date.now() - visionStart;
      console.error('[JewelryVision] Vision inference error:', err);
      if (isQuotaError(err)) return fail('Quota exhausted during vision step', true);
      return fail(err instanceof Error ? err.message : 'Unknown vision AI error');
    }
  }
  telemetry.vision_ms = Date.now() - visionStart;

  if (!parsed) {
    return fail('Vision model did not return valid JSON after retry', false, {
      rawVisionOutput: rawVisionOutput.slice(0, 1500),
    });
  }

  // Step 2: Normalize + apply trusted overrides
  const attributes = normalizeAttributes(parsed, options.categoryOverride);
  const aiCategoryGuess = attributes.category ?? null;
  if (options.forceJewelry) attributes.is_jewelry = true;
  if (options.categoryOverride) attributes.category = options.categoryOverride;

  // Step 3: Canonical text
  const embeddingText = buildEmbeddingText(attributes);
  telemetry.description_length = embeddingText.length;

  if (!attributes.is_jewelry) {
    // Rejected: no need to spend an embedding call
    telemetry.total_ms = Date.now() - start;
    return {
      ok: true, error: null, quotaExhausted: false, attributes, aiCategoryGuess, embeddingText,
      rawVisionOutput: rawVisionOutput.slice(0, 1500), vector: null, telemetry,
    };
  }

  // Step 4: Embedding
  const embStart = Date.now();
  try {
    const vector = await embedText(ai, embeddingText);
    telemetry.embedding_ms = Date.now() - embStart;
    telemetry.vector_dimensions = vector.length;
    telemetry.total_ms = Date.now() - start;
    return {
      ok: true, error: null, quotaExhausted: false, attributes, aiCategoryGuess, embeddingText,
      rawVisionOutput: rawVisionOutput.slice(0, 1500), vector, telemetry,
    };
  } catch (err) {
    telemetry.embedding_ms = Date.now() - embStart;
    console.error('[JewelryVision] Embedding error:', err);
    if (isQuotaError(err)) return fail('Quota exhausted during embedding step', true, { attributes, embeddingText });
    return fail(err instanceof Error ? err.message : 'Unknown embedding error', false, { attributes, embeddingText });
  }
}

// ─── Catalog indexing ─────────────────────────────────────────────────

export interface CatalogItemRef {
  id: string;
  item_id: string;
  image_key: string;
}

/**
 * Analyze a catalog image and upsert its vector (same id overwrites any older vector).
 * Category comes from the SKU prefix (ground truth), never from the AI.
 * A pendant set also gets a `<id>#earring` vector for its matching earrings.
 */
export async function embedCatalogItem(
  env: { AI: any; VECTORIZE: any; DB: D1Database },
  item: CatalogItemRef,
  imageBytes: Uint8Array
): Promise<PipelineResult> {
  const category = categoryFromItemId(item.item_id);
  const result = await analyzeJewelryImage(env.AI, imageBytes, { categoryOverride: category, forceJewelry: true });
  if (!result.ok || !result.vector || !result.attributes) return result;

  const vectors: any[] = [
    {
      id: item.id,
      values: result.vector,
      metadata: {
        item_id: item.item_id,
        image_key: item.image_key,
        category,
        prompt_version: PROMPT_VERSION,
        embed_text: (result.embeddingText || '').slice(0, 600),
        attrs_json: JSON.stringify(result.attributes),
      },
    },
  ];

  // Pendant set → second vector for the matching earrings (cheap: one more BGE call, no vision call)
  const componentId = `${item.id}${EARRING_COMPONENT_SUFFIX}`;
  const earrings = category === 'pendant_set' ? earringComponentAttributes(result.attributes) : null;
  if (earrings) {
    try {
      const text = buildEmbeddingText(earrings);
      vectors.push({
        id: componentId,
        values: await embedText(env.AI, text),
        metadata: {
          item_id: item.item_id,
          image_key: item.image_key,
          category: earrings.category,
          component: 'earring',
          parent_id: item.id,
          prompt_version: PROMPT_VERSION,
          embed_text: text.slice(0, 600),
          attrs_json: JSON.stringify(earrings),
        },
      });
    } catch (err) {
      // Non-fatal: the set is still searchable by its pendant
      console.warn(`[JewelryVision] Earring component embedding failed for ${item.item_id}:`, err);
    }
  }

  try {
    await env.VECTORIZE.upsert(vectors);
    if (!earrings) {
      // No earrings this time (or not a set): make sure no stale component vector lingers
      try { await env.VECTORIZE.deleteByIds([componentId]); } catch { /* may not exist */ }
    }
  } catch (err) {
    return { ...result, ok: false, error: `Vectorize upsert failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  await env.DB.prepare(`UPDATE plated_jewelry SET embedding_generated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), item.id)
    .run();

  return result;
}

/** Parse attributes stored in vector metadata (null for old v1 vectors). */
export function attributesFromMetadata(metadata: any): JewelryAttributes | null {
  if (!metadata?.attrs_json) return null;
  try {
    return JSON.parse(metadata.attrs_json);
  } catch {
    return null;
  }
}
