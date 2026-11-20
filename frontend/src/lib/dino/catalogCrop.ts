/**
 * Catalog photo -> DINO input, the v3 way (agreed 2026-11-20, #2):
 *   original pixels (full resolution) -> 900px copy (our own bilinear, resample.ts) -> red ID text removed ->
 *   cropped to the jewelry (catalogCropCore.ts) -> white square -> 448 -> 224 (our own bicubic, preprocess.ts)
 * Every step is the same maths as the validated study pipeline (Pillow), so no browser scaling is involved.
 *
 * Used by BOTH ways a catalog photo is learned, so they give the same fingerprint:
 *   - right after an upload (from the original photo)          -> utils/imageProcessor.ts
 *   - re-learning in Scan DINO (from the stored 900px photo)   -> ScanDinoView learnPending
 *
 * Never falls back to the whole photo: when no jewelry is found the caller gets { ok: false } and the item stays
 * "waiting to be learned" with a clear message (agreed: better unlearned and visible than learned badly).
 */
import { DINO_CATALOG_WORK_SIDE } from './config';
import { cleanAndCrop, type CropBox } from './catalogCropCore';
import { CATALOG_MAX_READ_PIXELS, readRegion, tensorFromRGBA } from './preprocess';
import { resampleRGBA } from './resample';

export type CatalogInput =
  | { ok: true; pixels: Float32Array; box: CropBox; textPixels: number; workWidth: number; workHeight: number }
  | { ok: false; reason: 'no_jewelry' };

export const NO_JEWELRY_ADVICE = 'Upload a clearer photo: plain background, the piece filling most of the frame.';

/** Python's round() (half to even), so working sizes match the validated pipeline exactly. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** The photo at the 900px working size (our own bilinear from full-resolution pixels). Also used by the ID reader. */
export function workCopy(source: CanvasImageSource, srcWidth: number, srcHeight: number): { data: Uint8ClampedArray; width: number; height: number } {
  if (!srcWidth || !srcHeight) throw new Error('Photo has no size');
  const orig = readRegion(source, { sx: 0, sy: 0, sw: srcWidth, sh: srcHeight }, { maxPixels: CATALOG_MAX_READ_PIXELS });
  const s = Math.min(1, DINO_CATALOG_WORK_SIDE / Math.max(orig.width, orig.height));
  if (s >= 1) return orig;
  const width = Math.max(1, pyRound(orig.width * s));
  const height = Math.max(1, pyRound(orig.height * s));
  return { data: resampleRGBA(orig.data, orig.width, orig.height, width, height, 'bilinear'), width, height };
}

/** Throws only on browser problems (no 2D canvas); "no jewelry" is a normal result, not an error. */
export function prepareCatalogInput(source: CanvasImageSource, srcWidth: number, srcHeight: number): CatalogInput {
  const { data: work, width: W, height: H } = workCopy(source, srcWidth, srcHeight);
  const r = cleanAndCrop(work, W, H); // paints the ID text in `work`, so the fingerprint never sees it
  if (!r.box) return { ok: false, reason: 'no_jewelry' };
  const pixels = tensorFromRGBA(work, W, H, r.box);
  return { ok: true, pixels, box: r.box, textPixels: r.textPixels, workWidth: W, workHeight: H };
}
