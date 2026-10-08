import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';

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

/** POST /api/images/upload — upload full + thumb for a plated jewelry item */
images.post('/upload', authMiddleware, ownerOnly, async (c) => {
  const formData = await c.req.formData();
  const fullImage = formData.get('full_image') as File | null;
  const thumbImage = formData.get('thumb_image') as File | null;
  const itemId = formData.get('item_id') as string | null;

  if (!fullImage || !thumbImage || !itemId) {
    return c.json({ error: 'full_image, thumb_image, and item_id are required' }, 400);
  }

  if (fullImage.size > MAX_FULL_SIZE) {
    return c.json({ error: 'Full image must be under 5MB' }, 400);
  }
  if (thumbImage.size > MAX_THUMB_SIZE) {
    return c.json({ error: 'Thumbnail must be under 500KB' }, 400);
  }

  // Verify the item exists
  const item = await c.env.DB.prepare(
    `SELECT id, image_key, thumb_key FROM plated_jewelry WHERE id = ? AND is_deleted = 0`
  ).bind(itemId).first<{ id: string; image_key: string | null; thumb_key: string | null }>();

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

  // Upload to R2
  const fullArrayBuffer = await fullImage.arrayBuffer();
  const thumbArrayBuffer = await thumbImage.arrayBuffer();

  await c.env.IMAGES.put(imageKey, fullArrayBuffer, {
    httpMetadata: { contentType: fullImage.type || 'image/webp' },
  });
  await c.env.IMAGES.put(thumbKey, thumbArrayBuffer, {
    httpMetadata: { contentType: thumbImage.type || 'image/webp' },
  });

  // Update D1 with R2 keys
  await c.env.DB.prepare(
    `UPDATE plated_jewelry SET image_key = ?, thumb_key = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(imageKey, thumbKey, itemId).run();

  return c.json({ success: true, image_key: imageKey, thumb_key: thumbKey });
});

/** GET /api/images/:key+ — serve image from R2 */
images.get('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const object = await c.env.IMAGES.get(key);

  if (!object) {
    return c.json({ error: 'Image not found' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/webp');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(object.body, { headers });
});

export default images;
