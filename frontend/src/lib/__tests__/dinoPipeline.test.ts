/**
 * DINO scanner v3 pipeline (agreed 2026-11-20): our own scaling (Pillow-exact), catalog clean-up + crop, model input.
 * Full-size parity with Pillow on the 79 sample photos is checked by scripts outside the repo; these pin the maths.
 */
import { describe, it, expect } from 'vitest';
import { resampleRGBA } from '../dino/resample';
import { cleanAndCrop, jewelBox, jewelMask, removeRedText } from '../dino/catalogCropCore';
import { tensorFromRGBA } from '../dino/preprocess';
import { DINO_MEAN, DINO_STD } from '../dino/config';

const toRGBA = (rgb: number[]) => {
  const out = new Uint8ClampedArray((rgb.length / 3) * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j] = rgb[i];
    out[j + 1] = rgb[i + 1];
    out[j + 2] = rgb[i + 2];
    out[j + 3] = 255;
  }
  return out;
};
const toRGB = (rgba: Uint8ClampedArray) => Array.from(rgba).filter((_, i) => i % 4 !== 3);

// 7x5 test picture and Pillow 11 results (Image.resize) for it
const SRC = [0, 0, 0, 37, 13, 7, 74, 26, 28, 111, 39, 63, 148, 52, 112, 185, 65, 175, 222, 78, 252, 11, 53, 29, 48, 66, 36, 85, 79, 57, 122, 92, 92, 159, 105, 141, 196, 118, 204, 233, 131, 25, 22, 106, 58, 59, 119, 65, 96, 132, 86, 133, 145, 121, 170, 158, 170, 207, 171, 233, 244, 184, 54, 33, 159, 87, 70, 172, 94, 107, 185, 115, 144, 198, 150, 181, 211, 199, 218, 224, 6, 255, 237, 83, 44, 212, 116, 81, 225, 123, 118, 238, 144, 155, 251, 179, 192, 8, 228, 229, 21, 35, 10, 34, 112];
const PIL_BICUBIC_3x2 = [36, 54, 30, 120, 87, 95, 207, 123, 157, 62, 179, 97, 148, 180, 156, 196, 143, 101];
const PIL_BILINEAR_4x3 = [24, 30, 16, 82, 50, 46, 150, 74, 123, 208, 94, 167, 41, 113, 62, 99, 133, 92, 167, 157, 158, 225, 177, 112, 58, 196, 108, 116, 216, 138, 184, 135, 164, 166, 114, 73];
const PIL_BICUBIC_UP_9x6 = [0, 0, 0, 22, 6, 2, 53, 17, 14, 82, 27, 34, 111, 37, 62, 140, 47, 99, 169, 57, 143, 200, 68, 206, 224, 77, 255, 6, 37, 21, 30, 46, 24, 61, 57, 36, 90, 67, 56, 119, 77, 84, 148, 87, 121, 177, 97, 180, 208, 108, 161, 232, 117, 68, 15, 83, 46, 39, 92, 49, 70, 103, 61, 99, 113, 81, 128, 123, 109, 157, 133, 145, 186, 143, 221, 217, 154, 177, 242, 163, 20, 25, 127, 70, 49, 136, 73, 80, 147, 85, 109, 157, 105, 138, 167, 133, 167, 188, 177, 195, 201, 168, 231, 211, 116, 255, 220, 63, 34, 173, 95, 58, 182, 98, 89, 193, 110, 118, 204, 130, 147, 213, 158, 176, 177, 214, 209, 174, 84, 218, 188, 12, 199, 197, 96, 42, 213, 117, 66, 222, 120, 97, 233, 132, 126, 248, 152, 155, 253, 180, 184, 44, 234, 231, 0, 117, 158, 19, 47, 0, 28, 117];

describe('our own scaling = Pillow (identical on every device)', () => {
  it('bicubic shrink matches Pillow exactly', () => {
    expect(toRGB(resampleRGBA(toRGBA(SRC), 7, 5, 3, 2, 'bicubic'))).toEqual(PIL_BICUBIC_3x2);
  });
  it('bilinear shrink matches Pillow exactly', () => {
    expect(toRGB(resampleRGBA(toRGBA(SRC), 7, 5, 4, 3, 'bilinear'))).toEqual(PIL_BILINEAR_4x3);
  });
  it('bicubic enlarge matches Pillow exactly (small pieces are enlarged to 448)', () => {
    expect(toRGB(resampleRGBA(toRGBA(SRC), 7, 5, 9, 6, 'bicubic'))).toEqual(PIL_BICUBIC_UP_9x6);
  });
  it('same size is an untouched copy', () => {
    const a = toRGBA(SRC);
    const b = resampleRGBA(a, 7, 5, 7, 5, 'bicubic');
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(b).not.toBe(a);
  });
});

// Synthetic catalog photo: grey cloth, a gold piece with a red stone, and red ID text on the cloth
function catalogPhoto(opts: { text?: boolean; piece?: boolean; speck?: boolean } = {}) {
  const W = 300, H = 240;
  const px = new Uint8ClampedArray(W * H * 4);
  const set = (x: number, y: number, c: number[]) => {
    const p = (y * W + x) * 4;
    px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, [200, 200, 205]); // grey cloth
  if (opts.piece !== false) {
    for (let y = 120; y < 200; y++) for (let x = 100; x < 200; x++) set(x, y, [200, 182, 100]); // yellow gold (like real kundan settings)
    for (let y = 150; y < 170; y++) for (let x = 140; x < 160; x++) set(x, y, [220, 30, 40]); // ruby inside the gold
  }
  if (opts.text !== false) {
    for (let y = 20; y < 50; y++) for (let x = 40; x < 140; x++) if ((x >> 3) % 2 === 0) set(x, y, [235, 40, 45]); // "letters"
  }
  if (opts.speck) for (let y = 60; y < 63; y++) for (let x = 60; x < 63; x++) set(x, y, [200, 182, 100]);
  return { px, W, H };
}
const pixel = (px: Uint8ClampedArray, W: number, x: number, y: number) => Array.from(px.slice((y * W + x) * 4, (y * W + x) * 4 + 3));

describe('catalog clean-up + crop', () => {
  it('paints the red ID text on the cloth, keeps the red stone inside the gold', () => {
    const { px, W, H } = catalogPhoto();
    const painted = removeRedText(px, W, H);
    expect(painted).toBeGreaterThan(0);
    expect(pixel(px, W, 40, 30)).toEqual([200, 200, 205]); // text -> cloth colour
    expect(pixel(px, W, 150, 160)).toEqual([220, 30, 40]); // ruby untouched
    expect(pixel(px, W, 120, 130)).toEqual([200, 182, 100]); // gold untouched
  });

  it('crops to the jewelry only (the ID text is not in the box)', () => {
    const { px, W, H } = catalogPhoto();
    const r = cleanAndCrop(px, W, H);
    expect(r.box).not.toBeNull();
    const b = r.box!;
    expect(b.sx).toBeLessThanOrEqual(100);
    expect(b.sx + b.sw).toBeGreaterThanOrEqual(200);
    expect(b.sy).toBeGreaterThan(50); // text (rows 20-50) left out
    expect(b.sy + b.sh).toBeGreaterThanOrEqual(200);
  });

  it('without text removal the box would stretch to the text (why step 1 exists)', () => {
    const { px, W, H } = catalogPhoto();
    const b = jewelBox(jewelMask(px, W, H), W, H)!;
    expect(b.sy).toBeLessThan(30);
  });

  it('no jewelry in the photo -> null (never the whole photo)', () => {
    const { px, W, H } = catalogPhoto({ piece: false, text: false });
    expect(cleanAndCrop(px, W, H).box).toBeNull();
  });

  it('a tiny speck is not a piece of jewelry -> null', () => {
    const { px, W, H } = catalogPhoto({ piece: false, text: false, speck: true });
    expect(cleanAndCrop(px, W, H).box).toBeNull();
  });
});

describe('model input', () => {
  it('a white picture gives the ImageNet-normalised white value in every channel, shape 3x224x224', () => {
    const W = 50, H = 30;
    const px = new Uint8ClampedArray(W * H * 4).fill(255);
    const t = tensorFromRGBA(px, W, H, { sx: 0, sy: 0, sw: W, sh: H });
    expect(t.length).toBe(3 * 224 * 224);
    for (let c = 0; c < 3; c++) {
      expect(t[c * 224 * 224]).toBeCloseTo((1 - DINO_MEAN[c]) / DINO_STD[c], 5);
      expect(t[c * 224 * 224 + 224 * 112 + 112]).toBeCloseTo((1 - DINO_MEAN[c]) / DINO_STD[c], 5);
    }
  });
});
