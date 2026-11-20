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
import { isLowStock } from '../utils/lowStock';
import { scanCategoryFromItemId, scanKeyForPrefix, prefixFromFilter } from '../utils/jewelryCategory';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const dino = new Hono<AppEnv>();

// ─── Constants (must match frontend/src/lib/dino/config.ts) ─────────
// v3 (2026-11-20): catalog photos are cleaned (red ID text removed) and cropped to the jewelry at a 900px working
// size before the fingerprint is made, and scans send only the gold box. Fingerprints of earlier versions are
// ignored by search and shown as "waiting to be learned".
export const DINO_MODEL_VERSION = 'dinov2s-q8-224-cls-crop900-v3';
const DINO_DIMENSIONS = 384;
const MODEL_DIR = 'dinov2-small-v1'; // R2: models/dinov2-small-v1/model.onnx
const TOP_K = 6;
/** Asked from Vectorize (its maximum with metadata), so old-version fingerprints can be dropped and 6 remain. */
const QUERY_K = 20;
const MAX_EMBED_BATCH = 20;

/**
 * Result labels (agreed 2026-11-20). Worked out on simulated scans of the 79 sample photos with the final v3 app
 * pipeline: non-jewelry scored at most 0.22, so "no match" below 0.45 rejects all of it while hiding only ~0.5% of
 * correct answers (0.50 hid ~2%; owner chose 0.45). 0.45-0.70 = "please check"; a gap under 0.02 between the top two
 * = "close call" (flagged ~16% of scans, catching 2 of 3 wrong answers). Re-tune with real scans after handover.
 */
export const DINO_THRESHOLDS = { no_match_below: 0.45, unsure_below: 0.7, close_call_gap: 0.02 } as const;
export type DinoVerdictKind = 'match' | 'close_call' | 'unsure' | 'no_match';

/** Scores must be best-first. One score per item (one fingerprint per item). */
export function dinoVerdict(scores: number[]): { kind: DinoVerdictKind; top_score: number | null; gap: number | null } {
  const top = scores.length ? scores[0] : null;
  const gap = scores.length > 1 ? scores[0] - scores[1] : null;
  const r = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);
  let kind: DinoVerdictKind = 'match';
  if (top === null || top < DINO_THRESHOLDS.no_match_below) kind = 'no_match';
  else if (top < DINO_THRESHOLDS.unsure_below) kind = 'unsure';
  else if (gap !== null && gap < DINO_THRESHOLDS.close_call_gap) kind = 'close_call';
  return { kind, top_score: r(top), gap: r(gap) };
}

// Category comes from the design code's leading letters (utils/jewelryCategory.ts), never from the model.
const categoryFromItemId = scanCategoryFromItemId;

/**
 * Fingerprints learned before a jewelry type existed were labelled "other". The first time someone scans with that
 * type selected, its fingerprints are re-labelled (values unchanged), then the type is marked done.
 */
async function ensureScanTagged(env: Env, prefix: string): Promise<void> {
  const row = await env.DB.prepare('SELECT scan_tagged FROM jewelry_categories WHERE prefix = ?').bind(prefix).first<{ scan_tagged: number }>();
  if (!row || row.scan_tagged) return;
  const key = scanKeyForPrefix(prefix);
  const { results } = await env.DB.prepare(
    `SELECT d.item_uuid AS id FROM dino_embeddings d JOIN plated_jewelry p ON p.id = d.item_uuid
     WHERE p.is_deleted = 0 AND (UPPER(TRIM(p.item_id)) = ? OR UPPER(TRIM(p.item_id)) GLOB ?)`
  ).bind(prefix, `${prefix}[^A-Z]*`).all<{ id: string }>();
  const ids = (results || []).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 20) {
    const found = await env.VECTORIZE_DINO.getByIds(ids.slice(i, i + 20));
    const fix = found
      .filter((v: VectorizeVector) => v.values && (v.metadata as Record<string, unknown> | undefined)?.category !== key)
      .map((v: VectorizeVector) => ({ id: v.id, values: Array.from(v.values as ArrayLike<number>), metadata: { ...(v.metadata || {}), category: key } }));
    if (fix.length) await env.VECTORIZE_DINO.upsert(fix);
  }
  await env.DB.prepare('UPDATE jewelry_categories SET scan_tagged = 1 WHERE prefix = ?').bind(prefix).run();
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

  // Optional guards used by learn-on-upload (bulk learning sends neither, so it behaves exactly as before):
  //   only_missing: never overwrite an item already learned by the current model
  //   items[].photo_etag: only save if the item's stored photo is still the one the vector was computed from
  //                       (the R2 etag returned by the upload; protects against a slow phone saving a fingerprint
  //                       of a photo that was replaced since — photo keys are stable, so the key can't tell)
  const onlyMissing = body?.only_missing === true;
  const prepared: { id: string; values: number[]; photoEtag: string | null }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const it of items) {
    const values = validVector(it?.vector);
    if (typeof it?.id !== 'string' || !values) {
      skipped.push({ id: String(it?.id ?? '?'), reason: 'invalid id or vector' });
      continue;
    }
    if (it.photo_etag !== undefined && (typeof it.photo_etag !== 'string' || it.photo_etag.length > 128)) {
      skipped.push({ id: it.id, reason: 'invalid photo_etag' });
      continue;
    }
    prepared.push({ id: it.id, values, photoEtag: typeof it.photo_etag === 'string' ? it.photo_etag : null });
  }
  if (prepared.length === 0) return c.json({ success: false, embedded: 0, skipped }, 400);

  // Only embed items that still exist and have a photo
  const placeholders = prepared.map(() => '?').join(',');
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.item_id, p.image_key, d.model_version AS done_model
     FROM plated_jewelry p LEFT JOIN dino_embeddings d ON d.item_uuid = p.id
     WHERE p.id IN (${placeholders}) AND p.is_deleted = 0 AND p.image_key IS NOT NULL`
  )
    .bind(...prepared.map((p) => p.id))
    .all<{ id: string; item_id: string; image_key: string; done_model: string | null }>();
  const live = new Map((results || []).map((r) => [r.id, r]));

  const vectors = [];
  const accepted: typeof prepared = [];
  for (const p of prepared) {
    const row = live.get(p.id);
    if (!row) {
      skipped.push({ id: p.id, reason: 'item deleted or has no photo' });
      continue;
    }
    if (p.photoEtag !== null) {
      const head = await c.env.IMAGES.head(row.image_key);
      if (!head || head.etag !== p.photoEtag) {
        skipped.push({ id: p.id, reason: 'photo changed since this fingerprint was made' });
        continue;
      }
    }
    if (onlyMissing && row.done_model === DINO_MODEL_VERSION) {
      skipped.push({ id: p.id, reason: 'already learned' });
      continue;
    }
    const itemId = row.item_id;
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
    const prefix = prefixFromFilter(body.category); // "NK", or an older app's "earring"
    if (!prefix) return c.json({ error: 'Invalid category' }, 400);
    category = scanKeyForPrefix(prefix);
    try {
      await ensureScanTagged(c.env, prefix);
    } catch (e) {
      console.warn('[DINO] Re-labelling fingerprints for', prefix, 'failed (search continues):', e);
    }
  }

  let vr: any;
  const vStart = Date.now();
  try {
    vr = await c.env.VECTORIZE_DINO.query(vector, {
      topK: QUERY_K,
      returnMetadata: 'all',
      ...(category ? { filter: { category } } : {}),
    });
  } catch (e) {
    console.error('[DINO] Vectorize query error:', e);
    return c.json({ error: 'Vector search failed.', detail: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
  const vectorizeMs = Date.now() - vStart;
  const found: any[] = vr?.matches || [];
  // Only fingerprints made the current way are comparable with this scan; older ones wait to be re-learned
  const raw: any[] = found
    .filter((m) => m.metadata?.model_version === DINO_MODEL_VERSION)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);
  const outdated = found.length - found.filter((m) => m.metadata?.model_version === DINO_MODEL_VERSION).length;

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
        is_low_stock: isLowStock(item.quantity, item.low_stock_threshold),
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
    verdict: dinoVerdict(matches.map((m) => m.score as number)),
    thresholds: DINO_THRESHOLDS,
    filter_warning:
      category && raw.length === 0
        ? 'No items matched this category. Nothing in this category is learned yet, or the category filter index is missing.'
        : null,
    telemetry: { vectorize_ms: vectorizeMs, db_ms: dbMs, total_ms: totalMs, matches_found: raw.length, outdated_ignored: outdated },
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
