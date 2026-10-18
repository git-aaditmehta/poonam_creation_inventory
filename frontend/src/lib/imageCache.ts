/**
 * imageCache.ts
 * 
 * Image caching layer using IndexedDB for persistent blob storage
 * and an in-memory LRU cache for fast re-access.
 * 
 * Images are NOT stored in SQLite (binary decoupling rule).
 * Uses IndexedDB separately for blob storage.
 */

const DB_NAME = 'poonam-image-cache';
const DB_VERSION = 1;
const STORE_NAME = 'images';
const LRU_MAX_SIZE = 150;

// ── In-Memory LRU Cache ───────────────────────────────────────

class LRUCache {
  private cache = new Map<string, string>(); // key → objectURL
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): string | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, value);

    // Evict oldest if over capacity
    if (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        const oldUrl = this.cache.get(oldestKey);
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        this.cache.delete(oldestKey);
      }
    }
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    for (const url of this.cache.values()) {
      URL.revokeObjectURL(url);
    }
    this.cache.clear();
  }
}

// ── IndexedDB Image Store ─────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function getIDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('cached_at', 'cached_at', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.error('[ImageCache] IndexedDB open error:', request.error);
      reject(request.error);
    };
  });

  return dbPromise;
}

async function idbGet(key: string): Promise<{ key: string; blob: Blob; size_bytes: number; cached_at: string } | undefined> {
  const db = await getIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, blob: Blob): Promise<void> {
  const db = await getIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({
      key,
      blob,
      size_bytes: blob.size,
      cached_at: new Date().toISOString(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await getIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClear(): Promise<void> {
  const db = await getIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetTotalSize(): Promise<number> {
  const db = await getIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    let total = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        total += cursor.value.size_bytes || 0;
        cursor.continue();
      } else {
        resolve(total);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Public API ─────────────────────────────────────────────────

const lru = new LRUCache(LRU_MAX_SIZE);
const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

/** 
 * Get an image URL. Checks memory cache → IndexedDB → network fetch.
 * Returns an object URL for cached images, or the remote URL as fallback.
 */
export async function getCachedImageUrl(
  key: string | null | undefined,
  timestamp?: string
): Promise<string> {
  if (!key) return '';

  const cacheKey = key;

  // 1. Check memory LRU
  const memCached = lru.get(cacheKey);
  if (memCached) return memCached;

  // 2. Check IndexedDB
  try {
    const cached = await idbGet(cacheKey);
    if (cached) {
      const objectUrl = URL.createObjectURL(cached.blob);
      lru.set(cacheKey, objectUrl);
      return objectUrl;
    }
  } catch (err) {
    console.warn('[ImageCache] IDB read error:', err);
  }

  // 3. Fetch from network and cache
  const remoteUrl = `${API_BASE_URL}/api/images/${key}${timestamp ? `?t=${encodeURIComponent(timestamp)}` : ''}`;

  if (!navigator.onLine) {
    // Offline and not cached — return placeholder or empty
    return '';
  }

  try {
    const token = sessionStorage.getItem('session_token') || localStorage.getItem('session_token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(remoteUrl, { headers, credentials: 'include' });
    if (!response.ok) return remoteUrl;

    const blob = await response.blob();

    // Store in IndexedDB
    try {
      await idbPut(cacheKey, blob);
    } catch (err) {
      console.warn('[ImageCache] IDB write error:', err);
    }

    // Create object URL and add to LRU
    const objectUrl = URL.createObjectURL(blob);
    lru.set(cacheKey, objectUrl);
    return objectUrl;

  } catch (err) {
    // Network error — return direct URL (may fail if offline)
    return remoteUrl;
  }
}

/**
 * Get the direct remote URL (no caching). For cases where we just need the URL string.
 */
export function getRemoteImageUrl(key?: string | null, timestamp?: string): string {
  if (!key) return '';
  const base = `${API_BASE_URL}/api/images/${key}`;
  return timestamp ? `${base}?t=${encodeURIComponent(timestamp)}` : base;
}

/** Invalidate a cached image (e.g., after re-upload). */
export async function invalidateImage(key: string): Promise<void> {
  try {
    await idbDelete(key);
  } catch { /* ignore */ }
  // LRU eviction happens naturally
}

/** Get total size of cached images in bytes. */
export async function getCachedImagesTotalSize(): Promise<number> {
  try {
    return await idbGetTotalSize();
  } catch {
    return 0;
  }
}

/** Clear all cached images. */
export async function clearImageCache(): Promise<void> {
  lru.clear();
  try {
    await idbClear();
  } catch { /* ignore */ }
}

/** Get storage estimate using the Storage API. */
export async function getStorageEstimate(): Promise<{ used: number; quota: number }> {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    return {
      used: estimate.usage || 0,
      quota: estimate.quota || 0,
    };
  }
  return { used: 0, quota: 0 };
}
