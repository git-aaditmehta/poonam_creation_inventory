/**
 * Catalog photo clean-up + crop for the DINO scanner — pure pixel maths (no DOM), so it can be tested anywhere.
 *
 * Agreed 2026-11-20 (#2). Port of the method validated in the accuracy study (scratchpad eval/ops900.py) on the
 * 79 sample photos: 91-92% correct first (vs ~77% with the whole photo), crops identical to full size.
 *
 *   1. Remove the red ID text printed on catalog photos. A red patch is text only when the ring around it is plain
 *      cloth; red/pink stones sit inside gold and are kept (checked by eye on all 79 photos).
 *   2. Find the jewelry: pixels that are strongly coloured, or very different from the photo's edge colour.
 *   3. Crop to it with an 8% margin. Nothing found -> null (the caller never falls back to the whole photo).
 *
 * All pixel distances are for the 900px working size (DINO_CATALOG_WORK_SIDE). Dilations use the 4-neighbour
 * ("cross") step like scipy's binary_dilation, i.e. everything within a city-block distance.
 */

export interface CropBox {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface CatalogCropResult {
  /** Crop around the jewelry, in working-image pixels; null when no jewelry was found */
  box: CropBox | null;
  /** Pixels painted over as ID text (0 = no text found) */
  textPixels: number;
}

/** Tuned for a 900px long side (study values 6/8/3/2/30 at 1600px, scaled by 900/1600). */
export const CROP_PARAMS = {
  wordGrow: 3, // join letters into words
  ringWidth: 5, // the surroundings that decide "text on cloth" vs "stone in gold"
  removeGrow: 2,
  finalGrow: 1,
  minCorePixels: 10, // smaller red specks are ignored
  goldenRingMax: 0.12, // ring less than 12% gold -> it is text on cloth
  rowColMinFraction: 0.004, // a row/column belongs to the jewelry if >0.4% of it is jewelry
  pad: 0.08,
  minBoxFraction: 0.04, // a "jewelry" box smaller than 4% of the long side is a speck, not a piece
} as const;

/** City-block distance (capped) from every pixel to the nearest set pixel of `mask`, inside the given window. */
function distanceWindow(mask: Uint8Array, W: number, x0: number, y0: number, x1: number, y1: number, cap: number, isSet: (i: number) => boolean): Uint8Array {
  const w = x1 - x0;
  const h = y1 - y0;
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (isSet((y + y0) * W + (x + x0))) {
        d[i] = 0;
        continue;
      }
      let v = cap + 1;
      if (y > 0 && d[i - w] + 1 < v) v = d[i - w] + 1;
      if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (y < h - 1 && d[i + w] + 1 < v) v = d[i + w] + 1;
      if (x < w - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
      d[i] = v;
    }
  }
  void mask;
  return d;
}

/** mask grown by k city-block steps (whole image). */
function dilate(mask: Uint8Array, W: number, H: number, k: number): Uint8Array {
  if (k <= 0) return mask.slice();
  const d = distanceWindow(mask, W, 0, 0, W, H, k, (i) => mask[i] === 1);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= k ? 1 : 0;
  return out;
}

/** Per-channel median of the photo's edge strip (numpy's median: mean of the two middle values when even). */
export function borderColor(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number): [number, number, number] {
  const b = Math.max(4, Math.floor(Math.min(H, W) * 0.04));
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  const add = (x: number, y: number) => {
    const p = (y * W + x) * 4;
    hist[0][rgba[p]]++;
    hist[1][rgba[p + 1]]++;
    hist[2][rgba[p + 2]]++;
    n++;
  };
  // same strips as numpy: top rows, bottom rows, left columns, right columns (corners counted twice)
  for (let y = 0; y < b; y++) for (let x = 0; x < W; x++) add(x, y);
  for (let y = H - b; y < H; y++) for (let x = 0; x < W; x++) add(x, y);
  for (let y = 0; y < H; y++) for (let x = 0; x < b; x++) add(x, y);
  for (let y = 0; y < H; y++) for (let x = W - b; x < W; x++) add(x, y);
  const kth = (h: Uint32Array, k: number) => {
    let c = 0;
    for (let v = 0; v < 256; v++) {
      c += h[v];
      if (c > k) return v;
    }
    return 255;
  };
  const med = (h: Uint32Array) => (n % 2 ? kth(h, (n - 1) / 2) : (kth(h, n / 2 - 1) + kth(h, n / 2)) / 2);
  return [med(hist[0]), med(hist[1]), med(hist[2])];
}

interface RedTextWord {
  id: number;
  /** Bounding box of the (grown) word, exclusive end */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** City-block distance to the word inside window [wx0,wx1) x [wy0,wy1) (ringWidth wider than the word) */
  dist: Uint8Array;
  wx0: number;
  wy0: number;
  wx1: number;
  wy1: number;
}

/**
 * Finds the red ID text: red letters joined into words; a word is text only when the ring around it is plain cloth
 * (less than 12% gold) — red/pink stones sit inside gold and are not text. Shared by the text remover (paints it)
 * and the ID reader (reads it), so both always agree on what the text is.
 */
function findRedTextWords(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number) {
  const P = CROP_PARAMS;
  const n = W * H;
  const core = new Uint8Array(n);
  const edge = new Uint8Array(n);
  const golden = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    core[i] = r > 180 && g < 130 && b < 130 && r - g > 80 ? 1 : 0;
    edge[i] = r - g > 25 && r - b > 25 ? 1 : 0;
    const mx = Math.max(r, g, b);
    const sat = (mx - Math.min(r, g, b)) / Math.max(mx, 1);
    golden[i] = sat > 0.35 && mx > 90 && !edge[i] ? 1 : 0;
  }
  const words = dilate(core, W, H, P.wordGrow);
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  const text: RedTextWord[] = [];
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (!words[s] || label[s]) continue;
    // 4-connected component of the grown text mask
    next++;
    let top = 0;
    stack[top++] = s;
    label[s] = next;
    let minX = W, minY = H, maxX = -1, maxY = -1, coreCount = 0;
    while (top) {
      const i = stack[--top];
      const x = i % W;
      const y = (i - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (core[i]) coreCount++;
      if (x > 0 && words[i - 1] && !label[i - 1]) { label[i - 1] = next; stack[top++] = i - 1; }
      if (x < W - 1 && words[i + 1] && !label[i + 1]) { label[i + 1] = next; stack[top++] = i + 1; }
      if (y > 0 && words[i - W] && !label[i - W]) { label[i - W] = next; stack[top++] = i - W; }
      if (y < H - 1 && words[i + W] && !label[i + W]) { label[i + W] = next; stack[top++] = i + W; }
    }
    if (coreCount < P.minCorePixels) continue;
    // Surroundings: pixels within ringWidth of the word (window is exact for city-block distance)
    const id = next;
    const wx0 = Math.max(0, minX - P.ringWidth);
    const wy0 = Math.max(0, minY - P.ringWidth);
    const wx1 = Math.min(W, maxX + 1 + P.ringWidth);
    const wy1 = Math.min(H, maxY + 1 + P.ringWidth);
    const dist = distanceWindow(words, W, wx0, wy0, wx1, wy1, P.ringWidth, (i) => label[i] === id);
    const ww = wx1 - wx0;
    let ring = 0;
    let gold = 0;
    for (let y = wy0; y < wy1; y++) {
      for (let x = wx0; x < wx1; x++) {
        const v = dist[(y - wy0) * ww + (x - wx0)];
        if (v >= 1 && v <= P.ringWidth) {
          ring++;
          if (golden[y * W + x]) gold++;
        }
      }
    }
    const goldenFraction = ring ? gold / ring : 1;
    if (goldenFraction >= P.goldenRingMax) continue; // red stone inside gold: keep
    text.push({ id, x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1, dist, wx0, wy0, wx1, wy1 });
  }
  return { core, edge, text };
}

/** Step 1. Paints the red ID text with the edge colour, in place. Returns the number of pixels painted. */
export function removeRedText(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number): number {
  const P = CROP_PARAMS;
  const n = W * H;
  const { core, edge, text } = findRedTextWords(rgba, W, H);
  const coreGrown = dilate(core, W, H, P.removeGrow);
  const remove = new Uint8Array(n);
  for (const t of text) {
    const ww = t.wx1 - t.wx0;
    for (let y = t.wy0; y < t.wy1; y++) {
      for (let x = t.wx0; x < t.wx1; x++) {
        const i = y * W + x;
        if (t.dist[(y - t.wy0) * ww + (x - t.wx0)] <= P.removeGrow && (edge[i] || core[i] || coreGrown[i])) remove[i] = 1;
      }
    }
  }
  const finalRemove = dilate(remove, W, H, P.finalGrow);
  // Edge colour of the photo BEFORE painting (as in the study), truncated to whole numbers
  const bg = borderColor(rgba, W, H).map((v) => Math.floor(v));
  let painted = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!finalRemove[i]) continue;
    rgba[p] = bg[0];
    rgba[p + 1] = bg[1];
    rgba[p + 2] = bg[2];
    painted++;
  }
  return painted;
}

export interface TextStrip {
  /** Grey-scale strip: black letters on white, 12px white margin (what the ID reader reads) */
  gray: Uint8ClampedArray;
  width: number;
  height: number;
  /** Where the line of text is in the working image */
  box: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * For the ID reader: the main line of red text (the biggest word plus the words beside it on the same line) as a
 * black-on-white strip, or null when the photo has no red ID text. Call on the working image BEFORE text removal.
 */
export function findTextLine(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number): TextStrip | null {
  const { edge, text } = findRedTextWords(rgba, W, H);
  if (!text.length) return null;
  const area = (t: RedTextWord) => (t.x1 - t.x0) * (t.y1 - t.y0);
  const big = text.reduce((a, b) => (area(b) > area(a) ? b : a));
  const line = text.filter((t) => Math.min(t.y1, big.y1) - Math.max(t.y0, big.y0) > 0.4 * (big.y1 - big.y0));
  const x0 = Math.min(...line.map((t) => t.x0));
  const y0 = Math.min(...line.map((t) => t.y0));
  const x1 = Math.max(...line.map((t) => t.x1));
  const y1 = Math.max(...line.map((t) => t.y1));
  const m = 12;
  const width = x1 - x0 + 2 * m;
  const height = y1 - y0 + 2 * m;
  const gray = new Uint8ClampedArray(width * height).fill(255);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (edge[y * W + x]) gray[(y - y0 + m) * width + (x - x0 + m)] = 0;
  }
  return { gray, width, height, box: { x0, y0, x1, y1 } };
}

/** Step 2. Jewelry mask: strongly coloured, or far from the edge colour; then a 3x3 median and a 3x3 max. */
export function jewelMask(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number): Uint8Array {
  const n = W * H;
  const bg = borderColor(rgba, W, H);
  const bgSat = (Math.max(...bg) - Math.min(...bg)) / Math.max(Math.max(...bg), 1);
  const raw = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const mx = Math.max(r, g, b);
    const sat = (mx - Math.min(r, g, b)) / Math.max(mx, 1);
    const dist = Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2]));
    raw[i] = (sat > bgSat + 0.18 && mx > 60) || dist > 95 ? 1 : 0;
  }
  // 3x3 filters with edge pixels repeated (like PIL's MedianFilter / MaxFilter)
  const at = (m: Uint8Array, x: number, y: number) => m[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  const med = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) c += at(raw, x + dx, y + dy);
      med[y * W + x] = c >= 5 ? 1 : 0;
    }
  }
  const out = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let any = 0;
      for (let dy = -1; dy <= 1 && !any; dy++) for (let dx = -1; dx <= 1 && !any; dx++) any = at(med, x + dx, y + dy);
      out[y * W + x] = any;
    }
  }
  return out;
}

/** Step 3. Box around the jewelry with an 8% margin, or null. */
export function jewelBox(mask: Uint8Array, W: number, H: number): CropBox | null {
  const P = CROP_PARAMS;
  const rowCount = new Uint32Array(H);
  const colCount = new Uint32Array(W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        rowCount[y]++;
        colCount[x]++;
      }
    }
  }
  const rows: number[] = [];
  const cols: number[] = [];
  for (let y = 0; y < H; y++) if (rowCount[y] / W > P.rowColMinFraction) rows.push(y);
  for (let x = 0; x < W; x++) if (colCount[x] / H > P.rowColMinFraction) cols.push(x);
  if (rows.length < 3 || cols.length < 3) return null;
  const x0 = cols[0];
  const x1 = cols[cols.length - 1] + 1;
  const y0 = rows[0];
  const y1 = rows[rows.length - 1] + 1;
  if (Math.max(x1 - x0, y1 - y0) < P.minBoxFraction * Math.max(W, H)) return null;
  const p = Math.floor(Math.max(x1 - x0, y1 - y0) * P.pad);
  const sx = Math.max(0, x0 - p);
  const sy = Math.max(0, y0 - p);
  return { sx, sy, sw: Math.min(W, x1 + p) - sx, sh: Math.min(H, y1 + p) - sy };
}

/** The whole clean-up on a working-size RGBA image (modified in place: text painted over). */
export function cleanAndCrop(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number): CatalogCropResult {
  const textPixels = removeRedText(rgba, W, H);
  const box = jewelBox(jewelMask(rgba, W, H), W, H);
  return { box, textPixels };
}
