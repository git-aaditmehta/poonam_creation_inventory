/**
 * Visual Search Routes — /api/visual-search
 *
 * Pipeline (shared with image upload auto-embed): see ../utils/jewelryVision.ts
 *   Llama 3.2 Vision → strict JSON attributes → canonical text → BGE-small (384-dim) → Vectorize
 *
 * Access Control:
 *   - Search / Descriptor: Owner + Staff (cost_price stripped for staff)
 *   - Embed / Delete / Backfill / Reset / Status: Owner only
 *
 * Category filtering requires a Vectorize metadata index on `category`:
 *   npx wrangler vectorize create-metadata-index jewelry-embeddings --propertyName=category --type=string
 * Vectors upserted before that index existed are not filterable → re-index after creating it.
 */
import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';
import { paisaToRupees } from '../utils/validation';
import { CLOSE_CALL_MARGIN, RANK_VERSION, finalScore, scoreAttributes } from '../utils/jewelryRank';
import {
  analyzeJewelryImage,
  attributesFromMetadata,
  embedCatalogItem,
  isFilterableCategory,
  EMBEDDING_MODEL,
  PROMPT_VERSION,
  VECTOR_DIMENSIONS,
  VISION_MODEL,
  EARRING_COMPONENT_SUFFIX,
  parentIdOf,
  type JewelryCategory,
} from '../utils/jewelryVision';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const visualSearch = new Hono<AppEnv>();

// ─── Constants ───────────────────────────────────────────────────────
const RESULT_COUNT = 6;
/** Candidates pulled from Vectorize before attribute re-ranking (metadata-returning queries allow up to 50). */
const CANDIDATE_COUNT = 50;
const CANDIDATE_COUNT_FALLBACK = 20;
const BACKFILL_BATCH_SIZE = 5; // each item = R2 read + 1–2 vision calls + embed + upsert + D1 write
const MAX_SEARCH_IMAGE_BYTES = 1024 * 1024; // 1 MB guard (client sends ≤1120px JPEG and keeps itself under ~450 KB)
const MIN_SCORE_THRESHOLD = 0.15; // effectively off for now; to be calibrated from test reports

// ─── Helpers ─────────────────────────────────────────────────────────
function checkBindings(c: any): Response | null {
  if (!c.env.AI) {
    return c.json({
      error: 'AI binding not available',
      message: 'Visual search requires Cloudflare Workers AI. If running locally, use: wrangler dev --remote',
    }, 503);
  }
  if (!c.env.VECTORIZE) {
    return c.json({
      error: 'Vectorize binding not available',
      message: 'Ensure the jewelry-embeddings index exists and is bound in wrangler.jsonc.',
    }, 503);
  }
  return null;
}

function quotaExhaustedResponse(c: any) {
  return c.json({
    success: false,
    quota_exhausted: true,
    error: 'Daily AI inference quota exhausted.',
    message: "Today's free AI quota has been reached. Quota resets at 00:00 UTC (05:30 AM IST). You can resume tomorrow.",
    reset_at_utc: '00:00 UTC',
  }, 429);
}

function decodeBase64Image(input: string): Uint8Array {
  const raw = input.includes(',') ? input.split(',')[1] : input;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;

// ═══════════════════════════════════════════════════════════════════════
// POST /api/visual-search/search — Camera/photo search (Owner + Staff)
// Body: { image: base64, category?: 'earring' | 'stud' | 'jhumka' | 'bracelet' | 'pendant_set' }
// ═══════════════════════════════════════════════════════════════════════
visualSearch.post('/search', authMiddleware, async (c) => {
  const bindingError = checkBindings(c);
  if (bindingError) return bindingError;

  const session = c.get('session');
  const isOwner = session.role === 'owner';

  let body: { image?: unknown; category?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be JSON with an "image" field containing base64-encoded image data.' }, 400);
  }

  if (!body.image || typeof body.image !== 'string') {
    return c.json({ error: 'Missing or invalid "image" field. Must be a base64-encoded string.' }, 400);
  }
  if (body.category !== undefined && body.category !== null && !isFilterableCategory(body.category)) {
    return c.json({ error: 'Invalid "category". Allowed: earring, stud, jhumka, bracelet, pendant_set.' }, 400);
  }
  const categoryFilter: JewelryCategory | null = isFilterableCategory(body.category) ? body.category : null;

  let imageBytes: Uint8Array;
  try {
    imageBytes = decodeBase64Image(body.image);
  } catch {
    return c.json({ error: 'Invalid base64 encoding. Could not decode image data.' }, 400);
  }
  if (imageBytes.length > MAX_SEARCH_IMAGE_BYTES) {
    return c.json({
      error: `Image too large (${Math.round(imageBytes.length / 1024)} KB). Must be under ${MAX_SEARCH_IMAGE_BYTES / 1024} KB.`,
    }, 400);
  }
  if (imageBytes.length < 100) {
    return c.json({ error: 'Image data is too small to be a valid image.' }, 400);
  }

  const searchStart = Date.now();

  // Step 1–4: Vision JSON → normalize → canonical text → vector
  const result = await analyzeJewelryImage(c.env.AI, imageBytes, {
    categoryOverride: categoryFilter || undefined,
  });

  if (result.quotaExhausted) return quotaExhaustedResponse(c);
  if (!result.ok) {
    return c.json({
      error: 'Failed to analyze image.',
      detail: result.error,
      raw_vision_output: result.rawVisionOutput,
      telemetry: result.telemetry,
    }, 500);
  }

  const baseResponse = {
    success: true,
    prompt_version: PROMPT_VERSION,
    category_filter: categoryFilter,
    ai_attributes: result.attributes,
    embedding_text: result.embeddingText,
    ai_description: result.embeddingText, // backward-compatible field
    raw_vision_output: result.rawVisionOutput,
  };

  // Not jewelry → reject without querying the index
  if (!result.attributes?.is_jewelry || !result.vector) {
    const totalMs = Date.now() - searchStart;
    return c.json({
      ...baseResponse,
      rejected: true,
      rejection_reason: 'The AI did not recognise this as jewelry.',
      matches: [],
      query_time_ms: totalMs,
      telemetry: { ...result.telemetry, vectorize_ms: 0, db_ms: 0, total_pipeline_ms: totalMs },
    });
  }

  // Step 5: Vectorize candidates (optionally filtered by category chip), then attribute re-ranking.
  // Many different pieces share an identical canonical text (cosine ties at 1.000), so the
  // vector step is only a recall stage; the order is decided field by field in Step 5b.
  let vectorResults: any;
  const vectorizeStart = Date.now();
  const queryOpts = { returnMetadata: 'all', ...(categoryFilter ? { filter: { category: categoryFilter } } : {}) };
  try {
    try {
      vectorResults = await c.env.VECTORIZE.query(result.vector, { topK: CANDIDATE_COUNT, ...queryOpts });
    } catch (firstErr) {
      console.warn('[VisualSearch] topK', CANDIDATE_COUNT, 'failed, retrying with', CANDIDATE_COUNT_FALLBACK, firstErr);
      vectorResults = await c.env.VECTORIZE.query(result.vector, { topK: CANDIDATE_COUNT_FALLBACK, ...queryOpts });
    }
  } catch (err) {
    console.error('[VisualSearch] Vectorize query error:', err);
    return c.json({ error: 'Vector search failed.', detail: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
  const vectorizeMs = Date.now() - vectorizeStart;

  const rawMatches: any[] = vectorResults?.matches || [];

  // Step 5b: re-rank candidates by attribute agreement + stretched cosine, keep the best RESULT_COUNT
  const queryAttrs = result.attributes;
  const ranked = rawMatches
    .filter((m) => m.score >= MIN_SCORE_THRESHOLD)
    .map((m) => {
      const candAttrs = attributesFromMetadata(m.metadata);
      const attr = candAttrs ? scoreAttributes(queryAttrs, candAttrs, { categoryCertain: Boolean(categoryFilter) }) : null;
      return {
        ...m,
        item_uuid: parentIdOf(m.id), // `<uuid>#earring` vectors belong to their pendant set
        component: m.metadata?.component ?? null,
        cosine: m.score,
        attr_score: attr?.score ?? null,
        breakdown: attr?.breakdown ?? null,
        final: finalScore(m.score, attr?.score ?? null),
      };
    })
    .sort((a, b) => b.final - a.final);
  // One row per catalog item: a set matched by both its pendant and its earrings keeps the better one
  const seenItems = new Set<string>();
  const perItem = ranked.filter((m) => {
    if (seenItems.has(m.item_uuid)) return false;
    seenItems.add(m.item_uuid);
    return true;
  });
  const qualifiedMatches = perItem.slice(0, RESULT_COUNT);
  const uncertain = perItem.length >= 2 && perItem[0].final - perItem[1].final < CLOSE_CALL_MARGIN;

  // Step 6: Fetch live inventory details from D1
  let dbResults: any[] = [];
  let dbMs = 0;
  if (qualifiedMatches.length > 0) {
    const ids = qualifiedMatches.map((m) => m.item_uuid);
    const placeholders = ids.map(() => '?').join(',');
    const dbStart = Date.now();
    try {
      const { results } = await c.env.DB.prepare(
        `SELECT id, item_id, quantity, unit, cost_price_cents, low_stock_threshold,
                image_key, thumb_key, created_at, updated_at
         FROM plated_jewelry
         WHERE id IN (${placeholders}) AND is_deleted = 0`
      ).bind(...ids).all();
      dbResults = results || [];
    } catch (err) {
      console.error('[VisualSearch] D1 query error:', err);
      return c.json({ error: 'Database lookup failed.', detail: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
    dbMs = Date.now() - dbStart;
  }

  // Step 7: Merge, preserving rank order
  const itemMap = new Map(dbResults.map((r: any) => [r.id, r]));
  const matches = qualifiedMatches
    .filter((m) => itemMap.has(m.item_uuid))
    .map((m) => {
      const item = itemMap.get(m.item_uuid);
      const match: Record<string, unknown> = {
        id: item.id,
        item_id: item.item_id,
        quantity: item.quantity,
        unit: item.unit,
        low_stock_threshold: item.low_stock_threshold,
        is_low_stock: item.quantity < item.low_stock_threshold,
        image_key: item.image_key,
        thumb_key: item.thumb_key,
        score: m.final, // final (re-ranked) score; cosine and attribute parts below
        match_cosine: m.cosine,
        match_attr_score: m.attr_score,
        match_breakdown: m.breakdown,
        match_component: m.component,
        created_at: item.created_at,
        updated_at: item.updated_at,
        // Diagnostics for the test report
        match_category: m.metadata?.category ?? null,
        match_prompt_version: m.metadata?.prompt_version ?? 'v1',
        match_embedding_text: m.metadata?.embed_text ?? null,
        match_attributes: attributesFromMetadata(m.metadata),
      };
      if (isOwner) match.cost_price = paisaToRupees(item.cost_price_cents);
      return match;
    });

  const totalMs = Date.now() - searchStart;

  let filterWarning: string | null = null;
  if (categoryFilter && rawMatches.length === 0) {
    filterWarning =
      'No vectors matched this category. Either nothing in this category is indexed yet, or the Vectorize metadata index on "category" is missing (create it, then re-index).';
  }

  // The chip is trusted for filtering, but if the model read the photo as something else, say so:
  // a wrong chip makes the correct item impossible to find.
  const guess = result.aiCategoryGuess;
  const categoryHintWarning =
    categoryFilter && guess && guess !== categoryFilter && guess !== 'other'
      ? `The AI read this photo as "${guess.replace('_', ' ')}", but the ${categoryFilter.replace('_', ' ')} chip is selected. Is the chip right?`
      : null;

  return c.json({
    ...baseResponse,
    rejected: false,
    query_time_ms: totalMs,
    matches,
    rank_version: RANK_VERSION,
    candidates_considered: perItem.length,
    uncertain,
    ai_category_guess: guess,
    category_hint_warning: categoryHintWarning,
    filter_warning: filterWarning,
    query_vector: result.vector.map(round),
    telemetry: {
      ...result.telemetry,
      vectorize_ms: vectorizeMs,
      db_ms: dbMs,
      total_pipeline_ms: totalMs,
      matches_found: rawMatches.length,
      matches_above_threshold: perItem.length,
      matches_with_db_data: matches.length,
      score_threshold: MIN_SCORE_THRESHOLD,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GET /api/visual-search/descriptor/:id — Stored vector + attributes of one item
// Used by the test report when the correct item was NOT in the top 6.
// ═══════════════════════════════════════════════════════════════════════
visualSearch.get('/descriptor/:id', authMiddleware, async (c) => {
  if (!c.env.VECTORIZE) return c.json({ error: 'Vectorize binding not available' }, 503);
  const id = c.req.param('id');
  try {
    const vectors = await c.env.VECTORIZE.getByIds([id]);
    const vec = vectors?.[0];
    if (!vec) return c.json({ success: true, indexed: false });
    return c.json({
      success: true,
      indexed: true,
      category: vec.metadata?.category ?? null,
      prompt_version: vec.metadata?.prompt_version ?? 'v1',
      embedding_text: vec.metadata?.embed_text ?? null,
      attributes: attributesFromMetadata(vec.metadata),
      values: Array.from(vec.values as ArrayLike<number>).map(round),
    });
  } catch (err) {
    return c.json({ error: 'Failed to read vector', detail: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /api/visual-search/descriptor/:id — Same, plus scores against a query
// Body: { vector: number[384], attributes: JewelryAttributes, category_filter?: string }
// Lets the test report show the re-ranked score of a correct item that was not in the top 6.
// ═══════════════════════════════════════════════════════════════════════
visualSearch.post('/descriptor/:id', authMiddleware, async (c) => {
  if (!c.env.VECTORIZE) return c.json({ error: 'Vectorize binding not available' }, 503);
  const id = c.req.param('id');
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const qv: unknown = body?.vector;
  if (!Array.isArray(qv) || qv.length !== VECTOR_DIMENSIONS || !qv.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    return c.json({ error: `vector must be ${VECTOR_DIMENSIONS} finite numbers` }, 400);
  }
  try {
    const vectors: any[] = (await c.env.VECTORIZE.getByIds([id, `${id}${EARRING_COMPONENT_SUFFIX}`])) || [];
    if (!vectors.length) return c.json({ success: true, indexed: false });
    const queryAttrs = body?.attributes && typeof body.attributes === 'object' ? body.attributes : null;
    const scored = vectors.map((vec) => {
      const values: number[] = Array.from(vec.values as ArrayLike<number>);
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < values.length; i++) {
        dot += values[i] * (qv[i] as number);
        na += values[i] * values[i];
        nb += (qv[i] as number) * (qv[i] as number);
      }
      const cosine = na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
      const candAttrs = attributesFromMetadata(vec.metadata);
      const attr = candAttrs && queryAttrs ? scoreAttributes(queryAttrs, candAttrs, { categoryCertain: Boolean(body?.category_filter) }) : null;
      return { vec, values, cosine, candAttrs, attr, final: finalScore(cosine, attr?.score ?? null) };
    });
    const best = scored.sort((a, b) => b.final - a.final)[0];
    return c.json({
      success: true,
      indexed: true,
      category: best.vec.metadata?.category ?? null,
      component: best.vec.metadata?.component ?? null,
      prompt_version: best.vec.metadata?.prompt_version ?? 'v1',
      embedding_text: best.vec.metadata?.embed_text ?? null,
      attributes: best.candAttrs,
      values: best.values.map(round),
      cosine: round(best.cosine),
      attr_score: best.attr?.score ?? null,
      breakdown: best.attr?.breakdown ?? null,
      score: round(best.final),
    });
  } catch (err) {
    return c.json({ error: 'Failed to read vector', detail: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /api/visual-search/embed/:id — Single item embedding (Owner only)
// ═══════════════════════════════════════════════════════════════════════
visualSearch.post('/embed/:id', authMiddleware, ownerOnly, async (c) => {
  const bindingError = checkBindings(c);
  if (bindingError) return bindingError;

  const itemId = c.req.param('id');
  const item = await c.env.DB.prepare(
    `SELECT id, item_id, image_key FROM plated_jewelry WHERE id = ? AND is_deleted = 0`
  ).bind(itemId).first<{ id: string; item_id: string; image_key: string | null }>();

  if (!item) return c.json({ error: 'Plated jewelry item not found' }, 404);
  if (!item.image_key) return c.json({ error: 'Item has no image uploaded. Upload an image first.' }, 400);

  const imageObj = await c.env.IMAGES.get(item.image_key);
  if (!imageObj) return c.json({ error: 'Image file not found in R2 storage', detail: `Key: ${item.image_key}` }, 404);
  const imageBytes = new Uint8Array(await imageObj.arrayBuffer());

  const result = await embedCatalogItem(c.env, { id: item.id, item_id: item.item_id, image_key: item.image_key }, imageBytes);
  if (result.quotaExhausted) return quotaExhaustedResponse(c);
  if (!result.ok) {
    return c.json({ error: 'Failed to generate embedding', detail: result.error, raw_vision_output: result.rawVisionOutput, telemetry: result.telemetry }, 500);
  }

  return c.json({
    success: true,
    item_id: item.item_id,
    embedded_at: new Date().toISOString(),
    ai_attributes: result.attributes,
    embedding_text: result.embeddingText,
    telemetry: result.telemetry,
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DELETE /api/visual-search/embed/:id — Remove embedding (Owner only)
// ═══════════════════════════════════════════════════════════════════════
visualSearch.delete('/embed/:id', authMiddleware, ownerOnly, async (c) => {
  const itemId = c.req.param('id');
  if (c.env.VECTORIZE) {
    try {
      await c.env.VECTORIZE.deleteByIds([itemId, `${itemId}${EARRING_COMPONENT_SUFFIX}`]);
    } catch (err) {
      console.warn(`[VisualSearch] Vectorize delete warning for ${itemId}:`, err);
    }
  }
  await c.env.DB.prepare(`UPDATE plated_jewelry SET embedding_generated_at = NULL WHERE id = ?`).bind(itemId).run();
  return c.json({ success: true, deleted: itemId });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /api/visual-search/reindex-reset — Mark every image as pending (Owner only)
// Vectors are NOT deleted: backfill overwrites each one (same id) with the current pipeline.
// ═══════════════════════════════════════════════════════════════════════
visualSearch.post('/reindex-reset', authMiddleware, ownerOnly, async (c) => {
  const result = await c.env.DB.prepare(
    `UPDATE plated_jewelry SET embedding_generated_at = NULL
     WHERE is_deleted = 0 AND image_key IS NOT NULL`
  ).run();
  return c.json({ success: true, reset: result.meta?.changes ?? 0, prompt_version: PROMPT_VERSION });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /api/visual-search/backfill — Progressive batch embedding (Owner only)
// ═══════════════════════════════════════════════════════════════════════
visualSearch.post('/backfill', authMiddleware, ownerOnly, async (c) => {
  const bindingError = checkBindings(c);
  if (bindingError) return bindingError;

  const { results: pendingItems } = await c.env.DB.prepare(
    `SELECT id, item_id, image_key FROM plated_jewelry
     WHERE is_deleted = 0 AND image_key IS NOT NULL AND embedding_generated_at IS NULL
     ORDER BY created_at ASC
     LIMIT ?`
  ).bind(BACKFILL_BATCH_SIZE).all<{ id: string; item_id: string; image_key: string }>();

  const countRemaining = async () => {
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) as remaining FROM plated_jewelry
       WHERE is_deleted = 0 AND image_key IS NOT NULL AND embedding_generated_at IS NULL`
    ).first<{ remaining: number }>();
    return row?.remaining || 0;
  };

  if (!pendingItems || pendingItems.length === 0) {
    return c.json({
      success: true, batch_size: 0, embedded: 0, failed: 0, skipped: 0,
      remaining: await countRemaining(), quota_exhausted: false, errors: [],
      message: 'All items with images have been embedded.',
    });
  }

  let embedded = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];
  let quotaHit = false;

  for (const item of pendingItems) {
    let imageBytes: Uint8Array;
    try {
      const imageObj = await c.env.IMAGES.get(item.image_key);
      if (!imageObj) {
        skipped++;
        errors.push(`${item.item_id}: image missing in R2`);
        continue;
      }
      imageBytes = new Uint8Array(await imageObj.arrayBuffer());
    } catch (err) {
      failed++;
      errors.push(`${item.item_id}: R2 read failed (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    const result = await embedCatalogItem(c.env, item, imageBytes);
    if (result.quotaExhausted) {
      quotaHit = true;
      errors.push(`Quota exhausted while embedding ${item.item_id}`);
      break;
    }
    if (!result.ok) {
      failed++;
      errors.push(`${item.item_id}: ${result.error}`);
      continue;
    }
    embedded++;
  }

  const response: Record<string, unknown> = {
    success: true,
    batch_size: pendingItems.length,
    embedded,
    failed,
    skipped,
    remaining: await countRemaining(),
    quota_exhausted: quotaHit,
    errors,
    prompt_version: PROMPT_VERSION,
  };
  if (quotaHit) {
    response.message = "Today's free AI quota has been reached. Quota resets at 00:00 UTC (05:30 AM IST). You can resume backfill tomorrow.";
    response.reset_at_utc = '00:00 UTC';
  }
  return c.json(response);
});

// ═══════════════════════════════════════════════════════════════════════
// GET /api/visual-search/status — Embedding coverage stats (Owner only)
// ═══════════════════════════════════════════════════════════════════════
visualSearch.get('/status', authMiddleware, ownerOnly, async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT
       COUNT(*) as total_items,
       COUNT(CASE WHEN image_key IS NOT NULL THEN 1 END) as with_images,
       COUNT(CASE WHEN image_key IS NOT NULL AND embedding_generated_at IS NOT NULL THEN 1 END) as indexed
     FROM plated_jewelry WHERE is_deleted = 0`
  ).first<{ total_items: number; with_images: number; indexed: number }>();

  const total = result?.total_items || 0;
  const withImages = result?.with_images || 0;
  const indexed = result?.indexed || 0;

  return c.json({
    success: true,
    total_items: total,
    with_images: withImages,
    indexed,
    coverage_percent: withImages > 0 ? Math.round((indexed / withImages) * 100) : 0,
    remaining: withImages - indexed,
    pipeline: {
      rank_version: RANK_VERSION,
      vision_model: VISION_MODEL,
      embedding_model: EMBEDDING_MODEL,
      vector_dimensions: VECTOR_DIMENSIONS,
      prompt_version: PROMPT_VERSION,
      max_items_free_tier: Math.floor(5_000_000 / VECTOR_DIMENSIONS),
    },
  });
});

export default visualSearch;
