/**
 * DINOv2 input preparation — identical for catalog photos and scans (that is what makes fingerprints comparable):
 *   1. read the region at its own resolution (no browser scaling)
 *   2. pad to a white square (never crop further — pieces near the edge stay in)
 *   3. resize to 448, then 224, with our own bicubic (resample.ts — same maths as Pillow, identical on every device)
 *   4. RGB / 255, ImageNet mean/std, CHW float32
 *
 * Agreed 2026-11-20: the browser's canvas scaling smeared fine detail (88% vs 91-92% correct first on the 79 sample
 * photos) and differed between browsers, so scaling is done in code. Only the canvas's 1:1 pixel read is used.
 */
import { DINO_INPUT_SIZE, DINO_MEAN, DINO_STD } from './config';
import { resampleRGBA } from './resample';

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Largest region read at full resolution for scans and gallery pictures. A bigger region (only very high-resolution
 * cameras/photos) is first reduced by the browser to this long side — a mild step — to keep phone memory low.
 */
export const SCAN_MAX_READ_SIDE = 2048;
/** Catalog photos (read once per upload): full resolution up to 16 MP, which covers 12 MP phone cameras. */
export const CATALOG_MAX_READ_PIXELS = 16_000_000;

// One reused canvas for 1:1 pixel reads (browsers limit total canvas memory; shrunk to 1x1 after every read)
let readCanvas: HTMLCanvasElement | null = null;

/** The pixels of `crop` from any drawable source, as RGBA. Scaled by the browser only when above the limits. */
export function readRegion(
  source: CanvasImageSource,
  crop: CropRect,
  limits: { maxSide?: number; maxPixels?: number }
): { data: Uint8ClampedArray; width: number; height: number } {
  const sx = Math.round(crop.sx);
  const sy = Math.round(crop.sy);
  const sw = Math.max(1, Math.round(crop.sw));
  const sh = Math.max(1, Math.round(crop.sh));
  let f = 1;
  if (limits.maxSide && Math.max(sw, sh) > limits.maxSide) f = Math.min(f, limits.maxSide / Math.max(sw, sh));
  if (limits.maxPixels && sw * sh > limits.maxPixels) f = Math.min(f, Math.sqrt(limits.maxPixels / (sw * sh)));
  const width = Math.max(1, Math.floor(sw * f));
  const height = Math.max(1, Math.floor(sh * f));
  if (!readCanvas) readCanvas = document.createElement('canvas');
  readCanvas.width = width;
  readCanvas.height = height;
  try {
    const ctx = readCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not get 2D canvas context');
    if (f < 1) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    } else {
      ctx.imageSmoothingEnabled = false; // 1:1 copy
    }
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
    return { data: ctx.getImageData(0, 0, width, height).data, width, height };
  } finally {
    readCanvas.width = 1;
    readCanvas.height = 1;
  }
}

/** Steps 2-4 on pixels already in memory: `box` (whole pixels) of an RGBA image -> 1x3x224x224 tensor data. */
export function tensorFromRGBA(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number, box: CropRect): Float32Array {
  const bx = Math.max(0, Math.round(box.sx));
  const by = Math.max(0, Math.round(box.sy));
  const bw = Math.max(1, Math.min(W - bx, Math.round(box.sw)));
  const bh = Math.max(1, Math.min(H - by, Math.round(box.sh)));
  // White square, the region pasted in the middle (Pillow paste offsets: floor)
  const s = Math.max(bw, bh);
  const sq = new Uint8ClampedArray(s * s * 4).fill(255);
  const ox = Math.floor((s - bw) / 2);
  const oy = Math.floor((s - bh) / 2);
  for (let y = 0; y < bh; y++) {
    const from = ((by + y) * W + bx) * 4;
    sq.set(rgba.subarray(from, from + bw * 4), ((oy + y) * s + ox) * 4);
  }
  const size = DINO_INPUT_SIZE;
  const mid = resampleRGBA(sq, s, s, size * 2, size * 2, 'bicubic');
  const out = resampleRGBA(mid, size * 2, size * 2, size, size, 'bicubic');
  const plane = size * size;
  const t = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    t[i] = (out[p] / 255 - DINO_MEAN[0]) / DINO_STD[0];
    t[plane + i] = (out[p + 1] / 255 - DINO_MEAN[1]) / DINO_STD[1];
    t[2 * plane + i] = (out[p + 2] / 255 - DINO_MEAN[2]) / DINO_STD[2];
  }
  return t;
}

/** Scans and gallery pictures: the `crop` region of `source` -> normalised 1x3x224x224 tensor data. */
export function preprocessToTensor(source: CanvasImageSource, crop: CropRect): Float32Array {
  const r = readRegion(source, crop, { maxSide: SCAN_MAX_READ_SIDE });
  return tensorFromRGBA(r.data, r.width, r.height, { sx: 0, sy: 0, sw: r.width, sh: r.height });
}
