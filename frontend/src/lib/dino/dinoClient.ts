/**
 * Main-thread wrapper around the DINOv2 worker. Input preparation lives in ./preprocess.ts.
 */
import {
  DINO_CACHE_NAME,
  DINO_FORCE_WASM,
  DINO_INPUT_SIZE,
  DINO_MODEL_BYTES,
  DINO_MODEL_FILE,
  DINO_MODEL_SHA256,
} from './config';
import { apiUrl } from '../../api';
import { preprocessToTensor, type CropRect } from './preprocess';

export interface DinoLoadInfo {
  backend: 'webgpu' | 'wasm';
  loadMs: number;
  fromCache: boolean;
  downloadMs: number;
}

export interface DinoEmbedding {
  vector: number[];
  preprocessMs: number;
  inferenceMs: number;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
let progressListener: ((loaded: number, total: number) => void) | null = null;
let loadPromise: Promise<DinoLoadInfo> | null = null;
let loadInfo: DinoLoadInfo | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./dinoWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      progressListener?.(msg.loaded, msg.total);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else p.resolve(msg);
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || 'DINO worker crashed');
    pending.forEach((p) => p.reject(err));
    pending.clear();
    worker?.terminate();
    worker = null;
    loadPromise = null;
    loadInfo = null;
  };
  return worker;
}

function call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

export function getDinoLoadInfo(): DinoLoadInfo | null {
  return loadInfo;
}

/** Downloads (first time) or reads the cached model, then creates the session. Safe to call repeatedly. */
export function loadDino(onProgress?: (loaded: number, total: number) => void): Promise<DinoLoadInfo> {
  progressListener = onProgress || null;
  if (loadInfo) return Promise.resolve(loadInfo);
  if (!loadPromise) {
    loadPromise = call<any>({
      type: 'load',
      modelUrl: apiUrl(`/api/visual-search-dino/model/${DINO_MODEL_FILE}`),
      sha256: DINO_MODEL_SHA256,
      cacheName: DINO_CACHE_NAME,
      expectedBytes: DINO_MODEL_BYTES,
      forceWasm: DINO_FORCE_WASM,
    })
      .then((m) => {
        loadInfo = { backend: m.backend, loadMs: m.loadMs, fromCache: m.fromCache, downloadMs: m.downloadMs };
        return loadInfo;
      })
      .catch((e) => {
        loadPromise = null; // allow Retry
        throw e;
      });
  }
  return loadPromise;
}

export { preprocessToTensor, type CropRect } from './preprocess';

/** Full on-device fingerprint for an image source (model must be loaded). */
export async function embedImage(source: CanvasImageSource, crop: CropRect): Promise<DinoEmbedding> {
  const t0 = performance.now();
  const pixels = preprocessToTensor(source, crop);
  const preprocessMs = Math.round(performance.now() - t0);
  const res = await call<any>({ type: 'embed', pixels, size: DINO_INPUT_SIZE }, [pixels.buffer]);
  return { vector: Array.from(res.vector as Float32Array), preprocessMs, inferenceMs: res.inferenceMs };
}

/** Fingerprint for input already prepared with preprocessToTensor (model must be loaded). Transfers `pixels`. */
export async function embedPixels(pixels: Float32Array): Promise<{ vector: number[]; inferenceMs: number }> {
  const res = await call<any>({ type: 'embed', pixels, size: DINO_INPUT_SIZE }, [pixels.buffer]);
  return { vector: Array.from(res.vector as Float32Array), inferenceMs: res.inferenceMs };
}

/** True when the model is already saved on this device (no 24 MB download needed). Never throws. */
export async function isDinoModelCached(): Promise<boolean> {
  if (loadInfo) return true;
  try {
    if (typeof caches === 'undefined') return false;
    const cache = await caches.open(DINO_CACHE_NAME);
    const hit = await cache.match(apiUrl(`/api/visual-search-dino/model/${DINO_MODEL_FILE}`));
    return Boolean(hit);
  } catch {
    return false;
  }
}

/** Loads a catalog photo (same-origin /api/images) as a bitmap with EXIF orientation applied. */
export async function loadCatalogBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Photo download failed (HTTP ${res.status})`);
  const blob = await res.blob();
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}
