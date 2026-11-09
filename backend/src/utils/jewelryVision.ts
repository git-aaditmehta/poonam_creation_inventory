/**
 * Jewelry Vision Pipeline (v2 — strict JSON attributes)
 *
 * Single source of truth for the image → attributes → text → 384-dim vector pipeline.
 * Used by: search (phone photos), single-item embed, backfill, and auto-embed on upload.
 * Catalog and query photos MUST go through the exact same prompt + text builder,
 * otherwise their vectors are not comparable.
 *
 *   Step 1: Llama 3.2 Vision → strict JSON with a fixed vocabulary (temperature 0)
 *   Step 2: Code validates/normalizes the JSON (unknown values are dropped)
 *   Step 3: Code builds a canonical, fixed-order text from the fields
 *   Step 4: BGE-small embeds that text → 384-dim vector
 *
 * Raw JSON is deliberately NOT embedded: braces/keys/quotes are identical in every
 * description and would push all similarity scores together.
 */

export const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
export const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
export const VECTOR_DIMENSIONS = 384;
export const PROMPT_VERSION = 'v2-json-1';

const VISION_MAX_TOKENS = 400; // JSON with ~16 fields needs ~150–250 tokens; headroom avoids truncation
const RETRY_TEMPERATURE = 0.3; // retrying at temperature 0 would return the same broken output

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
};

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
}

// ─── Prompt ───────────────────────────────────────────────────────────

export const JEWELRY_JSON_PROMPT = `You are an expert cataloguer of Indian gold-plated kundan jewelry. Look at the photo and fill in this JSON. Use ONLY the allowed values listed after each key.

{
  "is_jewelry": true | false,
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
  "has_cz_border": true | false
}

Definitions:
- stud: a single flat motif worn on the ear, no hanging parts.
- earring: a hanging earring with several parts (top motif plus drops, chandbali or jhumka).
- jhumka: a loose bell/dome-shaped jhumka piece on its own.
- pendant_set: a pendant, usually shown with matching small earrings.
- chandbali: crescent / half-moon shaped hanging frame.
- center_stone_color: color of the single largest or central stone.
- accent_colors: colored stones other than white/clear, plus "pearl" or "maroon_bead" if present.
- has_cz_border: a continuous line of tiny sparkling stones along an edge.

Rules:
1. IGNORE any printed text, numbers, codes, labels or red writing in the photo. Never mention them.
2. IGNORE the background, paper, cloth, earring stand, hands and shadows.
3. The photo may show 2, 4 or more identical copies. Describe ONE single piece.
4. For a pendant_set, describe the pendant, not the small earrings.
5. If the object is not jewelry (for example a watch, phone, coin, tool or random object), set "is_jewelry": false.
6. Reply with the JSON object ONLY. No explanation, no markdown, no text before or after.`;

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

function pickCount(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(9, Math.round(n)));
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

/** Validate + normalize raw model JSON into our fixed vocabulary. Unknown values are dropped. */
export function normalizeAttributes(obj: Record<string, unknown>): JewelryAttributes {
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
  return attrs;
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
  if (a.main_stone_type && a.main_stone_type !== 'none') parts.push(`${a.main_stone_type} stones`);
  if (a.motif && a.motif !== 'none') parts.push(`${a.motif} motif`);
  if (a.has_pearls) parts.push('pearls');
  if (a.has_hanging_beads) parts.push('hanging beads');
  if (a.has_cz_border) parts.push('cz stone border');
  if (a.metal_tone) parts.push(words(a.metal_tone));
  return parts.join('. ') + '.';
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

async function runVision(ai: any, imageBytes: Uint8Array, temperature: number) {
  const result = await ai.run(VISION_MODEL, {
    image: [...imageBytes],
    prompt: JEWELRY_JSON_PROMPT,
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
      ok: false, error, quotaExhausted, attributes: null, embeddingText: null,
      rawVisionOutput: null, vector: null, telemetry, ...extra,
    };
  };

  // Step 1: Vision → JSON (one retry at a higher temperature if the JSON is unusable)
  let parsed: Record<string, unknown> | null = null;
  let rawVisionOutput = '';
  const visionStart = Date.now();
  for (const temperature of [0, RETRY_TEMPERATURE]) {
    telemetry.vision_attempts++;
    try {
      const out = await runVision(ai, imageBytes, temperature);
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
  const attributes = normalizeAttributes(parsed);
  if (options.forceJewelry) attributes.is_jewelry = true;
  if (options.categoryOverride) attributes.category = options.categoryOverride;

  // Step 3: Canonical text
  const embeddingText = buildEmbeddingText(attributes);
  telemetry.description_length = embeddingText.length;

  if (!attributes.is_jewelry) {
    // Rejected: no need to spend an embedding call
    telemetry.total_ms = Date.now() - start;
    return {
      ok: true, error: null, quotaExhausted: false, attributes, embeddingText,
      rawVisionOutput: rawVisionOutput.slice(0, 1500), vector: null, telemetry,
    };
  }

  // Step 4: Embedding
  const embStart = Date.now();
  try {
    const result = await ai.run(EMBEDDING_MODEL, { text: [embeddingText] });
    telemetry.embedding_ms = Date.now() - embStart;
    const vector = result?.data?.[0] as number[] | undefined;
    if (!vector) return fail('Embedding model returned empty vector', false, { attributes, embeddingText });
    if (vector.length !== VECTOR_DIMENSIONS) {
      return fail(`Unexpected dimensions: ${vector.length} (expected ${VECTOR_DIMENSIONS})`, false, { attributes, embeddingText });
    }
    telemetry.vector_dimensions = vector.length;
    telemetry.total_ms = Date.now() - start;
    return {
      ok: true, error: null, quotaExhausted: false, attributes, embeddingText,
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
 */
export async function embedCatalogItem(
  env: { AI: any; VECTORIZE: any; DB: D1Database },
  item: CatalogItemRef,
  imageBytes: Uint8Array
): Promise<PipelineResult> {
  const category = categoryFromItemId(item.item_id);
  const result = await analyzeJewelryImage(env.AI, imageBytes, { categoryOverride: category, forceJewelry: true });
  if (!result.ok || !result.vector || !result.attributes) return result;

  try {
    await env.VECTORIZE.upsert([
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
    ]);
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
