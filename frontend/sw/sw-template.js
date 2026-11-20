/* Poonam Creation service worker (generated at build time from frontend/sw/sw-template.js).
 *
 * - App files are stored at install, so the app opens instantly and works offline.
 * - GRID photos (…-thumb): every one is kept, no limit (agreed: all grid photos offline by default). The app
 *   downloads all of them in the background (lib/photoOffline.ts); this worker serves them from the phone.
 * - FULL photos (…-full): kept as they are opened, at most MAX_FULL_PHOTOS (oldest removed first). Offline,
 *   a full photo that is not stored falls back to the item's grid photo.
 * - ID reader engine (/ocr/v6/...): not stored at install; kept on the device the first time the owner turns
 *   "Read ID from photo" on (about 7 MB), so it then works offline.
 * - Live data (/api/...) is never cached: it always comes from the server (or the phone's own database).
 * - A new deploy installs in the background and waits; the app shows "Update available" and activates it
 *   on request (SKIP_WAITING), so nobody is switched to a new version in the middle of their work.
 */
const VERSION = '__VERSION__';
const APP_CACHE = `app-${VERSION}`;
const THUMB_CACHE = 'thumbs-v1'; // shared with lib/photoOffline.ts — keep the name in sync
const FULL_CACHE = 'full-v1';
const MAX_FULL_PHOTOS = 500;
const OCR_CACHE = 'ocr-v6'; // "Read ID from photo" engine (/ocr/v6/...): kept once downloaded, only if switched on
const OLD_CACHES = ['photos-v1'];
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then(async (cache) => {
      // One by one: a single failed file must not abort the whole install (it is fetched again later)
      for (const url of PRECACHE) {
        try {
          const res = await fetch(url, { cache: 'reload' });
          if (res.ok) await cache.put(url, res);
        } catch {
          /* retried on the next install */
        }
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if ((name.startsWith('app-') && name !== APP_CACHE) || OLD_CACHES.includes(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

let fullPutsSinceTrim = 0;
async function trimFullPhotos(cache) {
  // In batches (listing 500 entries after every photo would be wasteful)
  if (++fullPutsSinceTrim < 25) return;
  fullPutsSinceTrim = 0;
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_FULL_PHOTOS; i++) await cache.delete(keys[i]);
}

/** ".../<version>-full" → ".../<version>-thumb" (older keys: ".../full" → ".../thumb"). */
function thumbUrlFor(fullUrl) {
  const u = new URL(fullUrl);
  u.pathname = u.pathname.replace(/-full$/, '-thumb').replace(/\/full$/, '/thumb');
  return u.toString();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ID reader engine: only fetched when the owner switches "Read ID from photo" on; kept for offline use
  if (url.pathname.startsWith('/ocr/v6/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(OCR_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
        return res;
      })()
    );
    return;
  }

  // Photos: the stored copy first, the network otherwise (and then stored)
  if (url.pathname.startsWith('/api/images/')) {
    const isFull = /(-|\/)full$/.test(url.pathname);
    const isThumb = /(-|\/)thumb$/.test(url.pathname);
    if (!isFull && !isThumb) return; // anything else under /api/images: plain network
    event.respondWith(
      (async () => {
        const cache = await caches.open(isFull ? FULL_CACHE : THUMB_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok && res.status === 200) {
            await cache.put(req, res.clone());
            if (isFull) trimFullPhotos(cache);
          }
          return res;
        } catch (err) {
          // Offline and this full photo is not stored: show the item's grid photo instead
          if (isFull) {
            const thumb = await (await caches.open(THUMB_CACHE)).match(thumbUrlFor(req.url));
            if (thumb) return thumb;
          }
          throw err;
        }
      })()
    );
    return;
  }

  // Everything else under /api is live data: never from a cache
  if (url.pathname.startsWith('/api/')) return;

  // Opening the app (any page address): the stored app first — instant and offline
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(APP_CACHE);
        const shell = (await cache.match('/index.html')) || (await cache.match('/'));
        if (shell) return shell;
        return fetch(req);
      })()
    );
    return;
  }

  // App files (content-hashed): stored copy first.
  // Returned as a NEW Response (no stored URL): a worker started as "file.js?vfs=opfs" must keep its
  // original address including "?vfs=…" (the SQLite storage helper reads it); a stored copy would hand it
  // the address without the query and break the phone's database.
  event.respondWith(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      const hit = await cache.match(url.pathname);
      if (hit) return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hit.headers });
      return fetch(req);
    })()
  );
});
