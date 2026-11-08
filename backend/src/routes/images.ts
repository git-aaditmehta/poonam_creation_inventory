import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';
import { logSyncChange } from '../utils/syncLog';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const images = new Hono<AppEnv>();

/**
 * Image handling strategy:
 *
 * Sharp/WASM is NOT used — it exceeds Cloudflare Workers bundle size limits
 * and memory constraints. Instead:
 *
 * 1. Client-side: Browser Canvas API creates thumbnail (200px) + full (1200px)
 *    as WebP (or JPEG fallback) before upload.
 * 2. Server-side: Worker receives both processed images and stores in R2.
 * 3. This keeps the Worker lean and image processing fast on the client.
 */

const MAX_FULL_SIZE = 5 * 1024 * 1024;  // 5MB
const MAX_THUMB_SIZE = 500 * 1024;       // 500KB
const ALLOWED_MIME = ['image/webp', 'image/jpeg', 'image/png'];

function isValidImageBytes(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;
  const bytes = new Uint8Array(buffer);
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return true;
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return true;
  }
  // WebP: 52 49 46 46 (RIFF) ... 57 45 42 50 (WEBP)
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return true;
  }
  return false;
}

/** POST /api/images/upload — upload full + thumb for a plated jewelry item */
images.post('/upload', authMiddleware, ownerOnly, async (c) => {
  const formData = await c.req.formData();
  const fullImage = formData.get('full_image') as File | null;
  const thumbImage = formData.get('thumb_image') as File | null;
  const itemId = formData.get('item_id') as string | null;

  if (!fullImage || !thumbImage || !itemId) {
    return c.json({ error: 'full_image, thumb_image, and item_id are required' }, 400);
  }

  if (
    (fullImage.type && !ALLOWED_MIME.includes(fullImage.type.toLowerCase())) ||
    (thumbImage.type && !ALLOWED_MIME.includes(thumbImage.type.toLowerCase()))
  ) {
    return c.json({ error: 'Unsupported image format. Allowed formats: WebP, JPEG, PNG.' }, 400);
  }

  if (fullImage.size > MAX_FULL_SIZE) {
    return c.json({ error: 'Full image must be under 5MB' }, 400);
  }
  if (thumbImage.size > MAX_THUMB_SIZE) {
    return c.json({ error: 'Thumbnail must be under 500KB' }, 400);
  }

  // Upload to R2
  const fullArrayBuffer = await fullImage.arrayBuffer();
  const thumbArrayBuffer = await thumbImage.arrayBuffer();

  if (!isValidImageBytes(fullArrayBuffer) || !isValidImageBytes(thumbArrayBuffer)) {
    return c.json({ error: 'Corrupted or invalid image file content' }, 400);
  }

  // Verify the item exists
  const item = await c.env.DB.prepare(
    `SELECT id, item_id, image_key, thumb_key FROM plated_jewelry WHERE id = ? AND is_deleted = 0`
  ).bind(itemId).first<{ id: string; item_id: string; image_key: string | null; thumb_key: string | null }>();

  if (!item) {
    return c.json({ error: 'Plated jewelry item not found' }, 404);
  }

  // Generate stable R2 keys based on item UUID (not mutable item_id)
  const imageKey = `plated/${itemId}/full`;
  const thumbKey = `plated/${itemId}/thumb`;

  // Delete old images if replacing
  if (item.image_key) {
    try { await c.env.IMAGES.delete(item.image_key); } catch { /* ignore */ }
  }
  if (item.thumb_key) {
    try { await c.env.IMAGES.delete(item.thumb_key); } catch { /* ignore */ }
  }

  await c.env.IMAGES.put(imageKey, fullArrayBuffer, {
    httpMetadata: { contentType: fullImage.type || 'image/webp' },
  });
  await c.env.IMAGES.put(thumbKey, thumbArrayBuffer, {
    httpMetadata: { contentType: thumbImage.type || 'image/webp' },
  });

  // Update D1 with R2 keys
  const nowIso = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE plated_jewelry SET image_key = ?, thumb_key = ?, updated_at = ? WHERE id = ?`
  ).bind(imageKey, thumbKey, nowIso, itemId).run();

  // Log CDC change so syncing clients receive the new image keys
  await logSyncChange(c.env.DB, 'plated_jewelry', itemId, 'UPDATE', {
    id: itemId,
    item_id: item.item_id,
    image_key: imageKey,
    thumb_key: thumbKey,
    updated_at: nowIso,
  });

  // ── Auto-Embed: Generate embedding via Llama Vision + BGE-small pipeline ──
  // Non-blocking: embedding failure does not prevent image upload success.
  let embeddingStatus: 'success' | 'skipped' | 'failed' = 'skipped';
  if (c.env.AI && c.env.VECTORIZE) {
    try {
      const visionModel = '@cf/meta/llama-3.2-11b-vision-instruct';
      const embeddingModel = '@cf/baai/bge-small-en-v1.5';
      const imageData = new Uint8Array(fullArrayBuffer);
      console.log(`[AutoEmbed] Starting Vision+BGE pipeline for ${item.item_id}, image: ${imageData.length} bytes`);

      // Step 1: Vision — extract structured description
      const visionStart = Date.now();
      const visionResult = await c.env.AI.run(visionModel, {
        image: [...imageData],
        prompt: `You are a jewelry catalog expert. Describe ONLY the jewelry piece in this image using these exact attributes in order:
1. TYPE: (earring/necklace/bangle/ring/bracelet/pendant/maang-tikka/nose-pin/anklet/set)
2. SUB-TYPE: (jhumka/stud/chandbali/hoop/drop/choker/collar/long-chain/kada/cuff)
3. SHAPE: (round/oval/teardrop/leaf/crescent/star/floral/geometric/elongated/dome)
4. METAL: (gold-plated/silver-plated/rose-gold/antique-gold/oxidized-silver/dual-tone)
5. STONES: list each stone type and color (kundan/AD/CZ/pearl/emerald-green/ruby-red/sapphire-blue/crystal-clear/polki/none)
6. STONE ARRANGEMENT: (center-mounted/border-set/clustered/scattered/dangling/layered/pavé/channel-set)
7. DESIGN: (filigree/meenakari/temple/floral/peacock/paisley/geometric/minimalist/traditional/fusion)
8. SIZE: (tiny/small/medium/large/oversized)
9. SPECIAL: any visible text, watermark, code number, or unique identifying mark
Write as one dense paragraph. Do NOT describe the background, hands, fabric, or anything except the jewelry itself.`,
        max_tokens: 150,
      });
      const visionMs = Date.now() - visionStart;

      const description = visionResult?.response || (typeof visionResult === 'string' ? visionResult : null);
      if (!description || description.trim().length < 10) {
        embeddingStatus = 'failed';
        console.warn(`[AutoEmbed] Vision returned empty/short description for ${item.item_id} (${visionMs}ms)`);
      } else {
        // Step 2: BGE embedding from description
        const embStart = Date.now();
        const embResult = await c.env.AI.run(embeddingModel, {
          text: [description.trim()],
        });
        const embMs = Date.now() - embStart;

        if (embResult?.data?.[0]) {
          await c.env.VECTORIZE.upsert([{
            id: itemId,
            values: embResult.data[0],
            metadata: {
              item_id: item.item_id,
              image_key: imageKey,
              description: description.trim().substring(0, 500),
            },
          }]);

          await c.env.DB.prepare(
            `UPDATE plated_jewelry SET embedding_generated_at = ? WHERE id = ?`
          ).bind(nowIso, itemId).run();

          embeddingStatus = 'success';
          console.log(`[AutoEmbed] Successfully embedded ${item.item_id} (vision: ${visionMs}ms, embed: ${embMs}ms)`);
        } else {
          embeddingStatus = 'failed';
          console.warn(`[AutoEmbed] BGE returned empty vector for ${item.item_id}`);
        }
      }
    } catch (err) {
      embeddingStatus = 'failed';
      // Log but don't fail the upload — embedding can be retried via backfill
      console.warn(`[AutoEmbed] Embedding failed for ${item.item_id} (non-fatal):`, err);
    }
  } else {
    console.log(`[AutoEmbed] Skipped — AI or Vectorize binding not available (local dev without --remote?)`);
  }

  return c.json({ success: true, image_key: imageKey, thumb_key: thumbKey, embedding: embeddingStatus });
});

/** GET /api/images/:key+ — serve image from R2 */
images.get('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  if (!key || key.includes('..') || key.startsWith('/') || key.includes('\\')) {
    return c.json({ error: 'Invalid image key' }, 400);
  }

  const object = await c.env.IMAGES.get(key);

  if (!object) {
    return c.json({ error: 'Image not found' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/webp');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');

  return new Response(object.body, { headers });
});

export default images;
