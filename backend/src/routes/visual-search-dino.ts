/**
 * On-device Visual Search (DINOv2) — /api/visual-search-dino
 *
 * Completely separate from the Llama pipeline (/api/visual-search):
 *   - own Vectorize index (binding VECTORIZE_DINO → jewelry-dinov2-384, cosine)
 *   - own D1 table (dino_embeddings)
 *   - never calls Workers AI (0 neurons): the phone/laptop runs DINOv2 and sends 384 numbers
 *
 * The model file itself is served from R2 (models/<MODEL_DIR>/...) so production does not
 * depend on Hugging Face.
 *
 * Access Control:
 *   - Search / Descriptor / Status: Owner + Staff (cost_price stripped for staff)
 *   - Pending / Embed / Reindex-reset: Owner only
 *   - Model files: public (open-source Apache-2.0 weights, cached by the browser)
 *
 * Category filtering requires a metadata index on the DINO index:
 *   npx wrangler vectorize create-metadata-index jewelry-dinov2-384 --propertyName=category --type=string
 */
import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';
import { paisaToRupees } from '../utils/validation';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const dino = new Hono<AppEnv>();

// ─── Constants (must match frontend/src/lib/dino/config.ts) ─────────
export const DINO_MODEL_VERSION = 'dinov2s-224-cls-v1';
const DINO_DIMENSIONS = 384;
const MODEL_DIR = 'dinov2-small-v1'; // R2: models/dinov2-small-v1/model.onnx
const TOP_K = 6;
const MAX_EMBED_BATCH = 20;

// Category comes from the SKU prefix (same convention as the catalog), never from the model.
// Kept local on purpose so this feature does not depend on the Llama pipeline's code.
const SKU_PREFIX_CATEGORY: Record<string, string> = {
  ER: 'earring',
  PS: 'stud',
  JK: 'jhumka',
  BR: 'bracelet',
  PD: 'pendant_set',
};
const FILTERABLE = new Set(Object.values(SKU_PREFIX_CATEGORY));

function categoryFromItemId(itemId: string | null | undefined): string {
  const m = (itemId || '').trim().match(/^([A-Za-z]+)/);
  return (m && SKU_PREFIX_CATEGORY[m[1].toUpperCase()]) || 'other';
}

/** Validates a client-supplied vector: exact length, finite numbers, non-zero. Returns it L2-normalised. */
function validVector(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== DINO_DIMENSIONS) return null;
  let norm = 0;
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    norm += x * x;
  }
  if (norm <= 1e-12) return null;
  const n = Math.sqrt(norm);
  return v.map((x: number) => x / n);
}

const round = (x: number) => Math.round(x * 1e5) / 1e5;

interface CatalogRow {
  id: string;
  item_id: string;
  image_key: string;
  updated_at: string;
  done_model: string | null;
}

/**
 * Every live item with a photo, plus which DINO model (if any) has learned it.
 * Pending = never learned, or learned by a different model version.
 * A replaced photo is pending too: the image upload route deletes the item's dino_embeddings row.
 */
async function loadCatalogState(db: D1Database): Promise<CatalogRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.item_id, p.image_key, p.updated_at, d.model_version AS done_model
       FROM plated_jewelry p
       LEFT JOIN dino_embeddings d ON d.item_uuid = p.id
       WHERE p.is_deleted = 0 AND p.image_key IS NOT NULL
       ORDER BY p.item_id`
    )
    .all<CatalogRow>();
  return results || [];
}

const isPending = (r: CatalogRow) => r.done_model !== DINO_MODEL_VERSION;

function bindingError(c: any) {
  if (!c.env.VECTORIZE_DINO) {
    return c.json({ error: 'DINO vector index is not configured on the server (VECTORIZE_DINO binding missing).' }, 503);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// GET /model/:file — model weights/config from R2 (public, immutable)
// ═══════════════════════════════════════════════════════════════════════
dino.get('/model/:file', async (c) => {
  const file = c.req.param('file');
  if (!/^[a-z0-9_.-]+$/i.test(file) || file.includes('..')) return c.json({ error: 'Invalid file' }, 400);
  const object = await c.env.IMAGES.get(`models/${MODEL_DIR}/${file}`);
  if (!object) return c.json({ error: 'Model file not found' }, 404);
  const headers = new Headers();
  headers.set('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
});

// ═══════════════════════════════════════════════════════════════════════
// GET /status — counts + "N new items waiting to be learned"
// ═══════════════════════════════════════════════════════════════════════
dino.get('/status', authMiddleware, async (c) => {
  const rows = await loadCatalogState(c.env.DB);
  const pending = rows.filter(isPending);
  return c.json({
    success: true,
    model_version: DINO_MODEL_VERSION,
    dimensions: DINO_DIMENSIONS,
    with_images: rows.length,
    indexed: rows.length - pending.length,
    pending: pending.length,
    index_configured: Boolean(c.env.VECTORIZE_DINO),
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GET /pending — items the owner's device must embed (owner only)
// ═══════════════════════════════════════════════════════════════════════
dino.get('/pending', authMiddleware, ownerOnly, async (c) => {
  const rows = await loadCatalogState(c.env.DB);
  return c.json({
    success: true,
    model_version: DINO_MODEL_VERSION,
    items: rows.filter(isPending).map((r) => ({
      id: r.id,
      item_id: r.item_id,
      image_key: r.image_key,
      updated_at: r.updated_at,
    })),
  });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /embed — store vectors computed on the owner's device (owner only)
// Body: { model_version, items: [{ id, vector: number[384] }] }
// ═══════════════════════════════════════════════════════════════════════
dino.post('/embed', authMiddleware, ownerOnly, async (c) => {
  const err = bindingError(c);
  if (err) return err;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (body?.model_version !== DINO_MODEL_VERSION) {
    return c.json(
      { error: `Model version mismatch: app sent "${body?.model_version}", server expects "${DINO_MODEL_VERSION}". Refresh the app.` },
      409
    );
  }
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) return c.json({ error: 'items[] is required' }, 400);
  if (items.length > MAX_EMBED_BATCH) return c.json({ error: `At most ${MAX_EMBED_BATCH} items per request` }, 400);

  const prepared: { id: string; values: number[] }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const it of items) {
    const values = validVector(it?.vector);
    if (typeof it?.id !== 'string' || !values) {
      skipped.push({ id: String(it?.id ?? '?'), reason: 'invalid id or vector' });
      continue;
    }
    prepared.push({ id: it.id, values });
  }
  if (prepared.length === 0) return c.json({ success: false, embedded: 0, skipped }, 400);

  // Only embed items that still exist and have a photo
  const placeholders = prepared.map(() => '?').join(',');
  const { results } = await c.env.DB.prepare(
    `SELECT id, item_id FROM plated_jewelry WHERE id IN (${placeholders}) AND is_deleted = 0 AND image_key IS NOT NULL`
  )
    .bind(...prepared.map((p) => p.id))
    .all<{ id: string; item_id: string }>();
  const live = new Map((results || []).map((r) => [r.id, r.item_id]));

  const vectors = [];
  const accepted: typeof prepared = [];
  for (const p of prepared) {
    const itemId = live.get(p.id);
    if (!itemId) {
      skipped.push({ id: p.id, reason: 'item deleted or has no photo' });
      continue;
    }
    vectors.push({
      id: p.id,
      values: p.values,
      metadata: { item_id: itemId, category: categoryFromItemId(itemId), model_version: DINO_MODEL_VERSION },
    });
    accepted.push(p);
  }
  if (vectors.length === 0) return c.json({ success: false, embedded: 0, skipped });

  try {
    await c.env.VECTORIZE_DINO.upsert(vectors);
  } catch (e) {
    console.error('[DINO] Vectorize upsert error:', e);
    return c.json({ error: 'Vector store failed', detail: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }

  const now = new Date().toISOString();
  await c.env.DB.batch(
    accepted.map((p) =>
      c.env.DB.prepare(
        `INSERT INTO dino_embeddings (item_uuid, model_version, embedded_at) VALUES (?, ?, ?)
         ON CONFLICT(item_uuid) DO UPDATE SET model_version = excluded.model_version, embedded_at = excluded.embedded_at`
      ).bind(p.id, DINO_MODEL_VERSION, now)
    )
  );

  return c.json({ success: true, embedded: accepted.length, skipped });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /search — nearest catalog items for a vector computed on the phone
// Body: { vector: number[384], category?: string }
// ═══════════════════════════════════════════════════════════════════════
dino.post('/search', authMiddleware, async (c) => {
  const err = bindingError(c);
  if (err) return err;
  const start = Date.now();
  const isOwner = c.get('session').role === 'owner';

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (body?.model_version && body.model_version !== DINO_MODEL_VERSION) {
    return c.json({ error: `Model version mismatch (app ${body.model_version}, server ${DINO_MODEL_VERSION}). Refresh the app.` }, 409);
  }
  const vector = validVector(body?.vector);
  if (!vector) return c.json({ error: `vector must be ${DINO_DIMENSIONS} finite numbers` }, 400);
  let category: string | null = null;
  if (body?.category !== undefined && body?.category !== null && body?.category !== '') {
    if (typeof body.category !== 'string' || !FILTERABLE.has(body.category)) {
      return c.json({ error: 'Invalid category' }, 400);
    }
    category = body.category;
  }

  let vr: any;
  const vStart = Date.now();
  try {
    vr = await c.env.VECTORIZE_DINO.query(vector, {
      topK: TOP_K,
      returnMetadata: 'all',
      ...(category ? { filter: { category } } : {}),
    });
  } catch (e) {
    console.error('[DINO] Vectorize query error:', e);
    return c.json({ error: 'Vector search failed.', detail: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
  const vectorizeMs = Date.now() - vStart;
  const raw: any[] = vr?.matches || [];

  let rows: any[] = [];
  let dbMs = 0;
  if (raw.length) {
    const ids = raw.map((m) => m.id);
    const dStart = Date.now();
    const { results } = await c.env.DB.prepare(
      `SELECT id, item_id, quantity, unit, cost_price_cents, low_stock_threshold,
              image_key, thumb_key, created_at, updated_at
       FROM plated_jewelry WHERE id IN (${ids.map(() => '?').join(',')}) AND is_deleted = 0`
    )
      .bind(...ids)
      .all();
    rows = results || [];
    dbMs = Date.now() - dStart;
  }
  const byId = new Map(rows.map((r: any) => [r.id, r]));
  const matches = raw
    .filter((m) => byId.has(m.id))
    .map((m) => {
      const item: any = byId.get(m.id);
      const out: Record<string, unknown> = {
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
        match_category: m.metadata?.category ?? null,
        match_model_version: m.metadata?.model_version ?? null,
      };
      if (isOwner) out.cost_price = paisaToRupees(item.cost_price_cents);
      return out;
    });

  const totalMs = Date.now() - start;
  return c.json({
    success: true,
    model_version: DINO_MODEL_VERSION,
    category_filter: category,
    matches,
    filter_warning:
      category && raw.length === 0
        ? 'No items matched this category. Nothing in this category is learned yet, or the category filter index is missing.'
        : null,
    telemetry: { vectorize_ms: vectorizeMs, db_ms: dbMs, total_ms: totalMs, matches_found: raw.length },
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GET /descriptor/:id — stored DINO vector of one item (for "not in top 6" scores)
// ═══════════════════════════════════════════════════════════════════════
dino.get('/descriptor/:id', authMiddleware, async (c) => {
  const err = bindingError(c);
  if (err) return err;
  const id = c.req.param('id');
  try {
    const found: any[] = await c.env.VECTORIZE_DINO.getByIds([id]);
    const v = found?.[0];
    if (!v) return c.json({ success: true, indexed: false, values: null, category: null, model_version: null });
    return c.json({
      success: true,
      indexed: true,
      category: v.metadata?.category ?? null,
      model_version: v.metadata?.model_version ?? null,
      values: Array.from(v.values as ArrayLike<number>).map(round),
    });
  } catch (e) {
    return c.json({ error: 'Descriptor lookup failed', detail: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /reindex-reset — mark every photo pending (owner). Vectors are overwritten on re-embed.
// ═══════════════════════════════════════════════════════════════════════
dino.post('/reindex-reset', authMiddleware, ownerOnly, async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM dino_embeddings').run();
  return c.json({ success: true, reset: res.meta.changes ?? 0, model_version: DINO_MODEL_VERSION });
});

export default dino;
