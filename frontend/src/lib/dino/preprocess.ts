/**
 * DINOv2 input preparation — identical for catalog photos, uploads and scans (that is what makes
 * fingerprints comparable):
 *   1. pad to a square with white (never crop — pieces near the edge must stay in the frame), 448px
 *   2. resize to 224x224
 *   3. RGB / 255, ImageNet mean/std, CHW float32
 *
 * Kept separate from dinoClient (no worker, no model) so the upload screen can prepare the input from the
 * ORIGINAL photo cheaply, before compression, without loading the model.
 */
import { DINO_INPUT_SIZE, DINO_MEAN, DINO_PAD_COLOR, DINO_STD } from './config';

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

