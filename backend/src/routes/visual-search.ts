/**
 * Visual Search Routes — /api/visual-search
 *
 * AI visual search for plated jewelry using a two-step serverless pipeline:
 *   Step 1: @cf/meta/llama-3.2-11b-vision-instruct — extracts structured visual description from image
 *   Step 2: @cf/baai/bge-small-en-v1.5 — converts text description to 384-dim vector
 *
 * This approach replaces the broken CLIP model (@cf/openai/clip-vit-base-patch32 is NOT available
 * on Cloudflare Workers AI). The two-step pipeline provides better discrimination between
 * similar jewelry pieces through explicit attribute extraction.
 *
 * Access Control:
 *   - Search: Owner + Staff (cost_price stripped for staff)
 *   - Embed/Delete/Backfill/Status: Owner only
 */
import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';
import { paisaToRupees } from '../utils/validation';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const visualSearch = new Hono<AppEnv>();

// ─── Constants ───────────────────────────────────────────────────────
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const VECTOR_DIMENSIONS = 384;
const VECTOR_TOP_K = 6;
const BACKFILL_BATCH_SIZE = 10;
const MAX_SEARCH_IMAGE_BYTES = 500 * 1024; // 500 KB guard for search uploads
const MIN_SCORE_THRESHOLD = 0.15; // Below this, results are noise
const VISION_MAX_TOKENS = 150; // Enough for detailed description, not wasteful

/**
 * ─── Jewelry Vision Prompt ──────────────────────────────────────────
 *
 * This prompt is carefully engineered to extract discriminative visual attributes
 * that differentiate similar jewelry pieces. The output format is a dense,
 * structured sentence that embeds well with BGE-small.
 *
 * Key design decisions:
 * 1. We ask for SPECIFIC attributes in a FIXED ORDER so embeddings are comparable
 * 2. We use jewelry-industry vocabulary (kundan, meenakari, jhumka, chandbali)
 *    so the model uses domain terms the embedding model can discriminate on
 * 3. We limit to ~100-150 tokens — BGE-small works best on focused text
 * 4. We ask for watermark/code extraction (e.g. "PS367") for bonus identification
 * 5. We explicitly say "do not describe background" to avoid noise from
 *    WhatsApp photos, hand-held shots, fabric backgrounds etc.
 */
const JEWELRY_VISION_PROMPT = `You are a jewelry catalog expert. Describe ONLY the jewelry piece in this image using these exact attributes in order:

1. TYPE: (earring/necklace/bangle/ring/bracelet/pendant/maang-tikka/nose-pin/anklet/set)
2. SUB-TYPE: (jhumka/stud/chandbali/hoop/drop/choker/collar/long-chain/kada/cuff)
3. SHAPE: (round/oval/teardrop/leaf/crescent/star/floral/geometric/elongated/dome)
4. METAL: (gold-plated/silver-plated/rose-gold/antique-gold/oxidized-silver/dual-tone)
5. STONES: list each stone type and color (kundan/AD/CZ/pearl/emerald-green/ruby-red/sapphire-blue/crystal-clear/polki/none)
6. STONE ARRANGEMENT: (center-mounted/border-set/clustered/scattered/dangling/layered/pavé/channel-set)
7. DESIGN: (filigree/meenakari/temple/floral/peacock/paisley/geometric/minimalist/traditional/fusion)
8. SIZE: (tiny/small/medium/large/oversized)
9. SPECIAL: any visible text, watermark, code number, or unique identifying mark

Write as one dense paragraph. Do NOT describe the background, hands, fabric, or anything except the jewelry itself.`;

// ─── Helper: Check if Vectorize + AI bindings are available ─────────
function checkBindings(c: any): Response | null {
  if (!c.env.AI) {
    console.error('[VisualSearch] AI binding is not available. Run with --remote or deploy to Cloudflare.');
    return c.json({
      error: 'AI binding not available',
      message: 'Visual search requires Cloudflare Workers AI. If running locally, use: wrangler dev --remote',
    }, 503);
  }
  if (!c.env.VECTORIZE) {
    console.error('[VisualSearch] VECTORIZE binding is not available. Ensure wrangler.jsonc has vectorize config.');
    return c.json({
      error: 'Vectorize binding not available',
      message: 'Visual search requires Cloudflare Vectorize. Ensure the jewelry-embeddings index exists and is bound in wrangler.jsonc.',
    }, 503);
  }
  return null;
}

// ─── Helper: Detect quota exhaustion from AI errors ─────────────────
function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('quota') || msg.includes('limit') || msg.includes('rate') || msg.includes('429');
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

// ─── Step 1: Vision — Extract structured text description from image ─
async function describeJewelryImage(
  ai: any,
  imageBytes: Uint8Array
): Promise<{
  description: string | null;
  error: string | null;
  quotaExhausted: boolean;
  durationMs: number;
  inputBytes: number;
}> {
  const startMs = Date.now();
  const inputBytes = imageBytes.length;
  try {
    const result = await ai.run(VISION_MODEL, {
      image: [...imageBytes],
      prompt: JEWELRY_VISION_PROMPT,
      max_tokens: VISION_MAX_TOKENS,
    });

    const durationMs = Date.now() - startMs;
    const description = result?.response || (typeof result === 'string' ? result : null);

    if (!description || description.trim().length < 10) {
      console.error('[VisualSearch] Vision model returned empty/short description:', JSON.stringify(result));
      return { description: null, error: 'Vision model returned insufficient description', quotaExhausted: false, durationMs, inputBytes };
    }

    console.log(`[VisualSearch] Vision description (${durationMs}ms, ${inputBytes}B): ${description.substring(0, 120)}...`);
    return { description: description.trim(), error: null, quotaExhausted: false, durationMs, inputBytes };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    console.error('[VisualSearch] Vision inference error:', err);
    if (isQuotaError(err)) {
      return { description: null, error: 'Quota exhausted', quotaExhausted: true, durationMs, inputBytes };
    }
    return {
      description: null,
      error: err instanceof Error ? err.message : 'Unknown vision AI error',
      quotaExhausted: false,
      durationMs,
      inputBytes,
    };
  }
}

// ─── Step 2: Embedding — Convert text description to 384-dim vector ──
async function generateTextEmbedding(
  ai: any,
  text: string
): Promise<{
  vector: number[] | null;
  error: string | null;
  quotaExhausted: boolean;
  durationMs: number;
  textLength: number;
}> {
  const startMs = Date.now();
  const textLength = text.length;
  try {
    const result = await ai.run(EMBEDDING_MODEL, {
      text: [text],
    });

    const durationMs = Date.now() - startMs;

    if (!result?.data?.[0]) {
      console.error('[VisualSearch] BGE embedding returned empty result:', JSON.stringify(result));
      return { vector: null, error: 'Embedding model returned empty vector', quotaExhausted: false, durationMs, textLength };
    }

    const vector = result.data[0] as number[];
    console.log(`[VisualSearch] BGE embedding (${durationMs}ms): ${vector.length} dimensions from ${textLength} chars`);

    if (vector.length !== VECTOR_DIMENSIONS) {
      console.error(`[VisualSearch] Unexpected vector dimensions: ${vector.length} (expected ${VECTOR_DIMENSIONS})`);
      return { vector: null, error: `Unexpected dimensions: ${vector.length}`, quotaExhausted: false, durationMs, textLength };
    }

    return { vector, error: null, quotaExhausted: false, durationMs, textLength };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    console.error('[VisualSearch] BGE embedding error:', err);
    if (isQuotaError(err)) {
      return { vector: null, error: 'Quota exhausted', quotaExhausted: true, durationMs, textLength };
    }
    return {
      vector: null,
      error: err instanceof Error ? err.message : 'Unknown embedding error',
      quotaExhausted: false,
      durationMs,
      textLength,
    };
  }
}

// ─── Combined: Image → Description → Vector (full pipeline) ─────────
async function generateEmbeddingFromImage(
  ai: any,
  imageBytes: Uint8Array
): Promise<{
  vector: number[] | null;
  description: string | null;
  error: string | null;
  quotaExhausted: boolean;
  telemetry: {
    vision_ms: number;
    embedding_ms: number;
    total_ms: number;
    image_bytes: number;
    description_length: number;
    vector_dimensions: number;
    vision_model: string;
    embedding_model: string;
  };
}> {
  const pipelineStart = Date.now();

  // Step 1: Vision
  const visionResult = await describeJewelryImage(ai, imageBytes);
  if (visionResult.quotaExhausted) {
    return {
      vector: null,
      description: null,
      error: 'Quota exhausted during vision step',
      quotaExhausted: true,
      telemetry: {
        vision_ms: visionResult.durationMs,
        embedding_ms: 0,
        total_ms: Date.now() - pipelineStart,
        image_bytes: imageBytes.length,
        description_length: 0,
        vector_dimensions: 0,
        vision_model: VISION_MODEL,
        embedding_model: EMBEDDING_MODEL,
      },
    };
  }
  if (visionResult.error || !visionResult.description) {
    return {
      vector: null,
      description: null,
      error: visionResult.error || 'Vision produced no description',
      quotaExhausted: false,
      telemetry: {
        vision_ms: visionResult.durationMs,
        embedding_ms: 0,
        total_ms: Date.now() - pipelineStart,
        image_bytes: imageBytes.length,
        description_length: 0,
        vector_dimensions: 0,
        vision_model: VISION_MODEL,
        embedding_model: EMBEDDING_MODEL,
      },
    };
  }

  // Step 2: Embedding
  const embResult = await generateTextEmbedding(ai, visionResult.description);
  const totalMs = Date.now() - pipelineStart;

  if (embResult.quotaExhausted) {
    return {
      vector: null,
      description: visionResult.description,
      error: 'Quota exhausted during embedding step',
      quotaExhausted: true,
      telemetry: {
        vision_ms: visionResult.durationMs,
        embedding_ms: embResult.durationMs,
        total_ms: totalMs,
        image_bytes: imageBytes.length,
        description_length: visionResult.description.length,
        vector_dimensions: 0,
        vision_model: VISION_MODEL,
        embedding_model: EMBEDDING_MODEL,
      },
    };
  }

  return {
    vector: embResult.vector,
    description: visionResult.description,
    error: embResult.error,
    quotaExhausted: false,
    telemetry: {
      vision_ms: visionResult.durationMs,
      embedding_ms: embResult.durationMs,
      total_ms: totalMs,
      image_bytes: imageBytes.length,
      description_length: visionResult.description.length,
      vector_dimensions: embResult.vector?.length || 0,
      vision_model: VISION_MODEL,
      embedding_model: EMBEDDING_MODEL,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// POST /api/visual-search/search — Camera/photo search (Owner + Staff)
// ═══════════════════════════════════════════════════════════════════════
visualSearch.post('/search', authMiddleware, async (c) => {
  const bindingError = checkBindings(c);
  if (bindingError) return bindingError;

  const session = c.get('session');
  const isOwner = session.role === 'owner';

  // Parse base64 image from JSON body
  let imageBase64: string;
  try {
    const body = await c.req.json<{ image: string }>();
    imageBase64 = body.image;
  } catch {
    return c.json({ error: 'Request body must be JSON with an "image" field containing base64-encoded image data.' }, 400);
  }

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return c.json({ error: 'Missing or invalid "image" field. Must be a base64-encoded string.' }, 400);
  }

  // Decode base64
  let imageBytes: Uint8Array;
  try {
    // Strip data URI prefix if present (e.g. "data:image/jpeg;base64,...")
    const raw = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const binaryStr = atob(raw);
    imageBytes = Uint8Array.from(binaryStr, (ch) => ch.charCodeAt(0));
  } catch {
    return c.json({ error: 'Invalid base64 encoding. Could not decode image data.' }, 400);
  }

  if (imageBytes.length > MAX_SEARCH_IMAGE_BYTES) {
    return c.json({
      error: `Image too large (${Math.round(imageBytes.length / 1024)} KB). The preprocessed image should be under ${MAX_SEARCH_IMAGE_BYTES / 1024} KB.`,
    }, 400);
  }

  if (imageBytes.length < 100) {
    return c.json({ error: 'Image data is too small to be a valid image.' }, 400);
  }

  console.log(`[VisualSearch] Search request from ${session.username} (${session.role}), image: ${imageBytes.length} bytes`);

  // Step 1+2: Generate query embedding via Vision + BGE pipeline
  const searchStart = Date.now();
  const {
    vector: queryVector,
    description: aiDescription,
    error: aiError,
    quotaExhausted,
    telemetry,
  } = await generateEmbeddingFromImage(c.env.AI, imageBytes);

  if (quotaExhausted) return quotaExhaustedResponse(c);
  if (aiError || !queryVector) {
    return c.json({
      error: 'Failed to generate visual embedding.',
      detail: aiError,
      telemetry,
    }, 500);
  }

  // Step 3: Query Vectorize for nearest neighbors
  let vectorResults: any;
  const vectorizeStart = Date.now();
  try {
    vectorResults = await c.env.VECTORIZE.query(queryVector, {
      topK: VECTOR_TOP_K,
      returnMetadata: 'all',
    });
  } catch (err) {
    console.error('[VisualSearch] Vectorize query error:', err);
    return c.json({ error: 'Vector search failed.', detail: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
  const vectorizeMs = Date.now() - vectorizeStart;

  if (!vectorResults?.matches?.length) {
    const totalMs = Date.now() - searchStart;
    console.log(`[VisualSearch] No matches found. Total time: ${totalMs}ms`);
    return c.json({
      success: true,
      matches: [],
      query_time_ms: totalMs,
      ai_description: aiDescription,
      telemetry: { ...telemetry, vectorize_ms: vectorizeMs, total_pipeline_ms: totalMs },
    });
  }

  // Step 4: Filter by minimum score threshold
  const qualifiedMatches = vectorResults.matches.filter(
    (m: any) => m.score >= MIN_SCORE_THRESHOLD
  );

  if (qualifiedMatches.length === 0) {
    const totalMs = Date.now() - searchStart;
    console.log(`[VisualSearch] All ${vectorResults.matches.length} matches below score threshold ${MIN_SCORE_THRESHOLD}. Total time: ${totalMs}ms`);
    return c.json({
      success: true,
      matches: [],
      query_time_ms: totalMs,
      ai_description: aiDescription,
      telemetry: { ...telemetry, vectorize_ms: vectorizeMs, total_pipeline_ms: totalMs },
    });
  }

  // Step 5: Fetch full item details from D1
  const ids = qualifiedMatches.map((m: any) => m.id);
  const placeholders = ids.map(() => '?').join(',');

  let dbResults: any[];
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
  const dbMs = Date.now() - dbStart;

  // Step 6: Merge vector scores with D1 data, preserving rank order
  const itemMap = new Map(dbResults.map((r: any) => [r.id, r]));
  const matches = qualifiedMatches
    .filter((m: any) => itemMap.has(m.id))
    .map((m: any) => {
      const item = itemMap.get(m.id);
      const result: Record<string, unknown> = {
        id: item.id,
        item_id: item.item_id,
        quantity: item.quantity,
        unit: item.unit,
        low_stock_threshold: item.low_stock_threshold,
        is_low_stock: item.quantity < item.low_stock_threshold,
        image_key: item.image_key,
        thumb_key: item.thumb_key,
        score: m.score,
        created_at: item.created_at,
        updated_at: item.updated_at,
      };

      // RBAC: Only owner sees cost price
      if (isOwner) {
        result.cost_price = paisaToRupees(item.cost_price_cents);
      }

      return result;
    });

  const totalMs = Date.now() - searchStart;
  console.log(`[VisualSearch] Found ${matches.length} matches in ${totalMs}ms`);

  return c.json({
    success: true,
    query_time_ms: totalMs,
    matches,
    ai_description: aiDescription,
    telemetry: {
      ...telemetry,
      vectorize_ms: vectorizeMs,
      db_ms: dbMs,
      total_pipeline_ms: totalMs,
      matches_found: vectorResults.matches.length,
      matches_above_threshold: qualifiedMatches.length,
      matches_with_db_data: matches.length,
      score_threshold: MIN_SCORE_THRESHOLD,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /api/visual-search/embed/:id — Single item embedding (Owner only)
// ═══════════════════════════════════════════════════════════════════════
visualSearch.post('/embed/:id', authMiddleware, ownerOnly, async (c) => {
  const bindingError = checkBindings(c);
  if (bindingError) return bindingError;

  const itemId = c.req.param('id');
  if (!itemId) return c.json({ error: 'Missing item ID' }, 400);

  console.log(`[VisualSearch] Embedding request for item: ${itemId}`);

  // Fetch item to get its R2 image key (1200px high-res WebP)
  const item = await c.env.DB.prepare(
    `SELECT id, item_id, image_key FROM plated_jewelry WHERE id = ? AND is_deleted = 0`
  ).bind(itemId).first<{ id: string; item_id: string; image_key: string | null }>();

  if (!item) {
    return c.json({ error: 'Plated jewelry item not found' }, 404);
  }
  if (!item.image_key) {
    return c.json({ error: 'Item has no image uploaded. Upload an image first.' }, 400);
  }

  // Read 1200px high-res image from R2
  let imageBytes: Uint8Array;
  try {
    const imageObj = await c.env.IMAGES.get(item.image_key);
    if (!imageObj) {
      return c.json({ error: 'Image file not found in R2 storage', detail: `Key: ${item.image_key}` }, 404);
    }
    imageBytes = new Uint8Array(await imageObj.arrayBuffer());
    console.log(`[VisualSearch] Read R2 image for ${item.item_id}: ${imageBytes.length} bytes (key: ${item.image_key})`);
  } catch (err) {
    console.error(`[VisualSearch] R2 read error for ${item.image_key}:`, err);
    return c.json({ error: 'Failed to read image from storage', detail: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }

  // Generate embedding via Vision + BGE pipeline
  const { vector, description, error: aiError, quotaExhausted, telemetry } = await generateEmbeddingFromImage(c.env.AI, imageBytes);

  if (quotaExhausted) return quotaExhaustedResponse(c);
  if (aiError || !vector) {
    return c.json({ error: 'Failed to generate embedding', detail: aiError, telemetry }, 500);
  }

  // Upsert into Vectorize
  try {
    await c.env.VECTORIZE.upsert([{
      id: item.id,
      values: vector,
      metadata: {
        item_id: item.item_id,
        image_key: item.image_key,
        description: (description || '').substring(0, 500), // Store description for debugging
      },
    }]);
  } catch (err) {
    console.error(`[VisualSearch] Vectorize upsert error for ${item.id}:`, err);
    return c.json({ error: 'Failed to store embedding in vector index', detail: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }

  // Update D1 tracking timestamp
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE plated_jewelry SET embedding_generated_at = ? WHERE id = ?`
  ).bind(now, item.id).run();

  console.log(`[VisualSearch] Successfully embedded item ${item.item_id} (${item.id})`);

  return c.json({
    success: true,
    item_id: item.item_id,
    embedded_at: now,
    ai_description: description,
    telemetry,
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DELETE /api/visual-search/embed/:id — Remove embedding (Owner only)
// ═══════════════════════════════════════════════════════════════════════
visualSearch.delete('/embed/:id', authMiddleware, ownerOnly, async (c) => {
  const itemId = c.req.param('id');
  if (!itemId) return c.json({ error: 'Missing item ID' }, 400);

  console.log(`[VisualSearch] Delete embedding request for item: ${itemId}`);

  // Delete from Vectorize (safe even if ID doesn't exist)
  if (c.env.VECTORIZE) {
    try {
      await c.env.VECTORIZE.deleteByIds([itemId]);
      console.log(`[VisualSearch] Deleted vector for ${itemId}`);
    } catch (err) {
      console.warn(`[VisualSearch] Vectorize delete warning for ${itemId}:`, err);
      // Non-fatal: the vector may not exist
    }
  }

  // Clear tracking timestamp in D1
  await c.env.DB.prepare(
    `UPDATE plated_jewelry SET embedding_generated_at = NULL WHERE id = ?`
  ).bind(itemId).run();

  return c.json({ success: true, deleted: itemId });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /api/visual-search/backfill — Progressive batch embedding (Owner only)
// ═══════════════════════════════════════════════════════════════════════
visualSearch.post('/backfill', authMiddleware, ownerOnly, async (c) => {
  const bindingError = checkBindings(c);
  if (bindingError) return bindingError;

  console.log(`[VisualSearch] Backfill request started (batch size: ${BACKFILL_BATCH_SIZE})`);

  // Find items with images but no embedding yet
  const { results: pendingItems } = await c.env.DB.prepare(
    `SELECT id, item_id, image_key FROM plated_jewelry
     WHERE is_deleted = 0
       AND image_key IS NOT NULL
       AND embedding_generated_at IS NULL
     ORDER BY created_at ASC
     LIMIT ?`
  ).bind(BACKFILL_BATCH_SIZE).all<{ id: string; item_id: string; image_key: string }>();

  if (!pendingItems || pendingItems.length === 0) {
    // Count remaining to confirm all done
    const countResult = await c.env.DB.prepare(
      `SELECT COUNT(*) as remaining FROM plated_jewelry
       WHERE is_deleted = 0 AND image_key IS NOT NULL AND embedding_generated_at IS NULL`
    ).first<{ remaining: number }>();

    return c.json({
      success: true,
      batch_size: 0,
      embedded: 0,
      failed: 0,
      skipped: 0,
      remaining: countResult?.remaining || 0,
      quota_exhausted: false,
      errors: [],
      message: 'All items with images have been embedded.',
    });
  }

  let embedded = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];
  let quotaHit = false;

  for (const item of pendingItems) {
    if (quotaHit) break;

    // Read image from R2
    let imageBytes: Uint8Array;
    try {
      const imageObj = await c.env.IMAGES.get(item.image_key);
      if (!imageObj) {
        console.warn(`[VisualSearch Backfill] Image not found in R2 for ${item.item_id}: ${item.image_key}`);
        skipped++;
        continue;
      }
      imageBytes = new Uint8Array(await imageObj.arrayBuffer());
    } catch (err) {
      const msg = `R2 read failed for ${item.item_id}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[VisualSearch Backfill] ${msg}`);
      errors.push(msg);
      failed++;
      continue;
    }

    // Generate embedding via full pipeline
    const { vector, description, error: aiError, quotaExhausted } = await generateEmbeddingFromImage(c.env.AI, imageBytes);

    if (quotaExhausted) {
      quotaHit = true;
      errors.push(`Quota exhausted while embedding ${item.item_id}`);
      break;
    }

    if (aiError || !vector) {
      const msg = `Pipeline failed for ${item.item_id}: ${aiError}`;
      console.error(`[VisualSearch Backfill] ${msg}`);
      errors.push(msg);
      failed++;
      continue;
    }

    // Upsert into Vectorize
    try {
      await c.env.VECTORIZE.upsert([{
        id: item.id,
        values: vector,
        metadata: {
          item_id: item.item_id,
          image_key: item.image_key,
          description: (description || '').substring(0, 500),
        },
      }]);
    } catch (err) {
      const msg = `Vectorize upsert failed for ${item.item_id}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[VisualSearch Backfill] ${msg}`);
      errors.push(msg);
      failed++;
      continue;
    }

    // Update D1 tracking
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE plated_jewelry SET embedding_generated_at = ? WHERE id = ?`
    ).bind(now, item.id).run();

    embedded++;
    console.log(`[VisualSearch Backfill] Embedded ${item.item_id} (${embedded}/${pendingItems.length})`);
  }

  // Count remaining
  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as remaining FROM plated_jewelry
     WHERE is_deleted = 0 AND image_key IS NOT NULL AND embedding_generated_at IS NULL`
  ).first<{ remaining: number }>();

  const response: Record<string, unknown> = {
    success: true,
    batch_size: pendingItems.length,
    embedded,
    failed,
    skipped,
    remaining: countResult?.remaining || 0,
    quota_exhausted: quotaHit,
    errors,
  };

  if (quotaHit) {
    response.message = "Today's free AI quota has been reached. Quota resets at 00:00 UTC (05:30 AM IST). You can resume backfill tomorrow.";
    response.reset_at_utc = '00:00 UTC';
  }

  console.log(`[VisualSearch Backfill] Batch complete: embedded=${embedded}, failed=${failed}, skipped=${skipped}, remaining=${countResult?.remaining || 0}`);

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
       COUNT(CASE WHEN embedding_generated_at IS NOT NULL THEN 1 END) as indexed
     FROM plated_jewelry WHERE is_deleted = 0`
  ).first<{ total_items: number; with_images: number; indexed: number }>();

  const total = result?.total_items || 0;
  const withImages = result?.with_images || 0;
  const indexed = result?.indexed || 0;
  const coverage = withImages > 0 ? Math.round((indexed / withImages) * 100) : 0;

  return c.json({
    success: true,
    total_items: total,
    with_images: withImages,
    indexed,
    coverage_percent: coverage,
    remaining: withImages - indexed,
    pipeline: {
      vision_model: VISION_MODEL,
      embedding_model: EMBEDDING_MODEL,
      vector_dimensions: VECTOR_DIMENSIONS,
      max_items_free_tier: Math.floor(5_000_000 / VECTOR_DIMENSIONS),
    },
  });
});

export default visualSearch;
