/**
 * Every grid photo stored on this phone, by default (agreed 2026-11-19: no cap, no button, not only "as
 * viewed"). Runs in the background after sync: downloads grid photos this phone does not have yet, and
 * removes stored ones whose item was deleted or whose photo was replaced. The service worker then serves
 * them from the phone, also offline (sw/sw-template.js uses the same cache name).
 *
 * Full-size photos are NOT downloaded here: they are kept as they are opened (max 500), and offline the grid
 * photo is shown instead.
 */
import { api } from '../api';
import { localDb } from './localDb';

const THUMB_CACHE = 'thumbs-v1'; // shared with sw/sw-template.js
const CONCURRENCY = 4;

let running: Promise<void> | null = null;
let again = false;

/** Ask the browser to keep this app's storage permanently (grid photos, offline data, Costing). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  if (typeof caches === 'undefined' || !navigator.onLine) return;
  await localDb.ready;
  const rows = await localDb.query<{ thumb_key: string; updated_at: string }>(
    `SELECT thumb_key, updated_at FROM plated_jewelry
     WHERE is_deleted = 0 AND thumb_key IS NOT NULL AND thumb_key != '' AND thumb_key NOT LIKE 'blob:%' AND thumb_key NOT LIKE 'data:%'`
  );
  const wanted = new Set(rows.map((r) => new URL(api.images.getUrl(r.thumb_key, r.updated_at), location.href).toString()));

  const cache = await caches.open(THUMB_CACHE);
  const stored = new Set((await cache.keys()).map((req) => req.url));

  // Grid photos of deleted items / replaced photos: free the space
  for (const url of stored) {
    if (!wanted.has(url)) await cache.delete(url);
  }

  const missing = [...wanted].filter((u) => !stored.has(u));
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      if (!navigator.onLine) return; // resumes on the next run
      const url = missing[next++];
      try {
        const res = await fetch(url);
        if (res.ok && res.status === 200) await cache.put(url, res);
      } catch {
        /* network blip: picked up on the next run */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
}

/** Bring the stored grid photos up to date (safe to call often: runs one at a time). */
export function syncGridPhotos(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = run()
    .catch((e) => console.warn('[Photos] Offline grid photo update failed (retried later):', e))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        syncGridPhotos();
      }
    });
  return running;
}

/** How many grid photos are stored on this phone (for display). */
export async function storedGridPhotoCount(): Promise<number> {
  try {
    return (await (await caches.open(THUMB_CACHE)).keys()).length;
  } catch {
    return 0;
  }
}
