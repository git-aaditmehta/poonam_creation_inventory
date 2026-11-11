/**
 * Main-thread wrapper around the DINOv2 worker.
 *
 * Preprocessing is identical for catalog photos and scans (that is what makes fingerprints comparable):
 *   1. pad to a square with white (never crop — pieces near the edge must stay in the frame)
 *   2. resize to 224x224 (stepwise halving first, so large camera frames don't alias)
 *   3. RGB / 255, ImageNet mean/std, CHW float32
 */
import {
  DINO_CACHE_NAME,
  DINO_INPUT_SIZE,
  DINO_MEAN,
  DINO_MODEL_BYTES,
  DINO_MODEL_FILE,
  DINO_MODEL_SHA256,
  DINO_PAD_COLOR,
  DINO_STD,
} from './config';
import { apiUrl } from '../../api';

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

/** Draws `source` padded to a square and returns the normalised 1x3x224x224 tensor data. */
export function preprocessToTensor(source: CanvasImageSource, srcW: number, srcH: number): Float32Array {
  const size = DINO_INPUT_SIZE;
  const side = Math.max(srcW, srcH);

  // Step 1: pad to a square at (at most) 4x the target size
  let cur = document.createElement('canvas');
  const firstSide = Math.min(side, size * 4);
  const scale = firstSide / side;
  cur.width = firstSide;
  cur.height = firstSide;
  let ctx = cur.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D canvas context');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = DINO_PAD_COLOR;
  ctx.fillRect(0, 0, firstSide, firstSide);
  const dw = srcW * scale;
  const dh = srcH * scale;
  ctx.drawImage(source, 0, 0, srcW, srcH, (firstSide - dw) / 2, (firstSide - dh) / 2, dw, dh);

  // Step 2: halve until within 2x, then final resize to 224
  while (cur.width / 2 >= size) {
    const next = document.createElement('canvas');
    next.width = Math.max(size, Math.floor(cur.width / 2));
    next.height = next.width;
    const nctx = next.getContext('2d')!;
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  if (cur.width !== size) {
    const fin = document.createElement('canvas');
    fin.width = size;
    fin.height = size;
    const fctx = fin.getContext('2d')!;
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(cur, 0, 0, size, size);
    cur = fin;
  }
  ctx = cur.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, size, size);

  // Step 3: normalise to CHW float32
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    out[i] = (data[p] / 255 - DINO_MEAN[0]) / DINO_STD[0];
    out[plane + i] = (data[p + 1] / 255 - DINO_MEAN[1]) / DINO_STD[1];
    out[2 * plane + i] = (data[p + 2] / 255 - DINO_MEAN[2]) / DINO_STD[2];
  }
  return out;
}

/** Full on-device fingerprint for an image source (model must be loaded). */
export async function embedImage(source: CanvasImageSource, srcW: number, srcH: number): Promise<DinoEmbedding> {
  const t0 = performance.now();
  const pixels = preprocessToTensor(source, srcW, srcH);
  const preprocessMs = Math.round(performance.now() - t0);
  const res = await call<any>({ type: 'embed', pixels, size: DINO_INPUT_SIZE }, [pixels.buffer]);
  return { vector: Array.from(res.vector as Float32Array), preprocessMs, inferenceMs: res.inferenceMs };
}

/** Loads a catalog photo (same-origin /api/images) as a bitmap with EXIF orientation applied. */
export async function loadCatalogBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Photo download failed (HTTP ${res.status})`);
  const blob = await res.blob();
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}
