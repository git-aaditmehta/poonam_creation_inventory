/**
 * Main-thread wrapper around the DINOv2 worker.
 *
 * Preprocessing is identical for catalog photos and scans (that is what makes fingerprints comparable):
 *   1. pad to a square with white (never crop — pieces near the edge must stay in the frame), 448px
 *   2. resize to 224x224
 *   3. RGB / 255, ImageNet mean/std, CHW float32
 */
import {
  DINO_CACHE_NAME,
  DINO_FORCE_WASM,
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

// Two small canvases reused for every photo. iOS Safari has a hard total-canvas-memory limit and frees
// canvases late, so creating new canvases per photo (old code) crashed the tab after a few dozen photos.
const PAD_SIDE = DINO_INPUT_SIZE * 2; // 448: intermediate step keeps downscaling sharp
let padCanvas: HTMLCanvasElement | null = null;
let outCanvas: HTMLCanvasElement | null = null;

function canvases(): { pad: CanvasRenderingContext2D; out: CanvasRenderingContext2D } {
  if (!padCanvas) {
    padCanvas = document.createElement('canvas');
    padCanvas.width = PAD_SIDE;
    padCanvas.height = PAD_SIDE;
  }
  if (!outCanvas) {
    outCanvas = document.createElement('canvas');
    outCanvas.width = DINO_INPUT_SIZE;
    outCanvas.height = DINO_INPUT_SIZE;
  }
  const pad = padCanvas.getContext('2d');
  const out = outCanvas.getContext('2d', { willReadFrequently: true });
  if (!pad || !out) throw new Error('Could not get 2D canvas context');
  pad.imageSmoothingEnabled = true;
  pad.imageSmoothingQuality = 'high';
  out.imageSmoothingEnabled = true;
  out.imageSmoothingQuality = 'high';
  return { pad, out };
}

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Draws the `crop` region of `source` padded to a white square (never cropped further), scales it to
 * 224x224 and returns the normalised 1x3x224x224 tensor data.
 */
export function preprocessToTensor(source: CanvasImageSource, crop: CropRect): Float32Array {
  const size = DINO_INPUT_SIZE;
  const { pad, out } = canvases();

  // Step 1: fit the region inside a 448 square, centred, white padding
  const scale = PAD_SIDE / Math.max(crop.sw, crop.sh);
  const dw = crop.sw * scale;
  const dh = crop.sh * scale;
  pad.fillStyle = DINO_PAD_COLOR;
  pad.fillRect(0, 0, PAD_SIDE, PAD_SIDE);
  pad.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, (PAD_SIDE - dw) / 2, (PAD_SIDE - dh) / 2, dw, dh);

  // Step 2: 448 → 224
  out.drawImage(padCanvas!, 0, 0, size, size);
  const { data } = out.getImageData(0, 0, size, size);

  // Step 3: normalise to CHW float32
  const plane = size * size;
  const t = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    t[i] = (data[p] / 255 - DINO_MEAN[0]) / DINO_STD[0];
    t[plane + i] = (data[p + 1] / 255 - DINO_MEAN[1]) / DINO_STD[1];
    t[2 * plane + i] = (data[p + 2] / 255 - DINO_MEAN[2]) / DINO_STD[2];
  }
  return t;
}

/** Full on-device fingerprint for an image source (model must be loaded). */
export async function embedImage(source: CanvasImageSource, crop: CropRect): Promise<DinoEmbedding> {
  const t0 = performance.now();
  const pixels = preprocessToTensor(source, crop);
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
