/**
 * Image scaling done in our own code instead of the browser's canvas (agreed 2026-11-20).
 *
 * Why: the browser's built-in scaling is made for speed and smears fine detail (stone edges, patterns) when a
 * picture is shrunk or enlarged a lot. On the 79 sample photos that cost 3-4 points of scanner accuracy
 * (88% vs 91-92%). It also differs between Chrome, Safari and Android, so the same photo gave slightly different
 * fingerprints on different devices. This file gives identical results everywhere.
 *
 * It is a faithful port of Pillow's resampling (libImaging/Resample.c): separable, antialiased (the filter widens
 * when shrinking), 8-bit fixed-point with 22 precision bits, horizontal pass first. Pure maths, no DOM.
 */

const PRECISION_BITS = 32 - 8 - 2;
const HALF = 1 << (PRECISION_BITS - 1);

type Filter = { support: number; fn: (x: number) => number };

const BILINEAR: Filter = {
  support: 1,
  fn: (x) => {
    const a = Math.abs(x);
    return a < 1 ? 1 - a : 0;
  },
};

const BICUBIC: Filter = {
  support: 2,
  fn: (x) => {
    const A = -0.5;
    const a = Math.abs(x);
    if (a < 1) return ((A + 2) * a - (A + 3)) * a * a + 1;
    if (a < 2) return (((a - 5) * a + 8) * a - 4) * A;
    return 0;
  },
};

export type ResampleFilter = 'bilinear' | 'bicubic';

/** Pillow's precompute_coeffs + normalize_coeffs_8bpc: per output pixel, first input index, count and int weights. */
function coeffs(inSize: number, outSize: number, f: Filter) {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1);
  const support = f.support * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const pre = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const ss = 1 / filterscale;
    // C's (int) truncates toward zero
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      const w = f.fn((x + xmin - center + 0.5) * ss);
      pre[x] = w;
      ww += w;
    }
    for (let x = 0; x < ksize; x++) {
      const v = x < xmax ? (ww !== 0 ? pre[x] / ww : pre[x]) : 0;
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS)) : Math.trunc(0.5 + v * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

const clip8 = (v: number) => {
  const x = v >> PRECISION_BITS;
  return x < 0 ? 0 : x > 255 ? 255 : x;
};

/**
 * Resize an RGBA image (alpha ignored, output alpha 255) exactly like Pillow's Image.resize(size, BILINEAR|BICUBIC).
 */
export function resampleRGBA(
  src: Uint8ClampedArray | Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  filter: ResampleFilter
): Uint8ClampedArray {
  if (sw === dw && sh === dh) return new Uint8ClampedArray(src);
  const f = filter === 'bicubic' ? BICUBIC : BILINEAR;
  const needH = dw !== sw;
  const needV = dh !== sh;
  const h = coeffs(sw, dw, f);
  const v = coeffs(sh, dh, f);

  let cur: Uint8ClampedArray | Uint8Array = src;
  let curW = sw;
  let curH = sh;
  if (needH) {
    // Only the rows the vertical pass will read
    const yFirst = v.bounds[0];
    const yLast = v.bounds[dh * 2 - 2] + v.bounds[dh * 2 - 1];
    const rows = needV ? yLast - yFirst : sh;
    const y0 = needV ? yFirst : 0;
    if (needV) for (let i = 0; i < dh; i++) v.bounds[i * 2] -= yFirst;
    const tmp = new Uint8ClampedArray(dw * rows * 4);
    for (let yy = 0; yy < rows; yy++) {
      const rowIn = (yy + y0) * sw * 4;
      const rowOut = yy * dw * 4;
      for (let xx = 0; xx < dw; xx++) {
        const xmin = h.bounds[xx * 2];
        const xmax = h.bounds[xx * 2 + 1];
        const k = xx * h.ksize;
        let s0 = HALF, s1 = HALF, s2 = HALF;
        for (let x = 0; x < xmax; x++) {
          const p = rowIn + (x + xmin) * 4;
          const w = h.kk[k + x];
          s0 += cur[p] * w;
          s1 += cur[p + 1] * w;
          s2 += cur[p + 2] * w;
        }
        const o = rowOut + xx * 4;
        tmp[o] = clip8(s0);
        tmp[o + 1] = clip8(s1);
        tmp[o + 2] = clip8(s2);
        tmp[o + 3] = 255;
      }
    }
    cur = tmp;
    curW = dw;
    curH = rows;
  }
  if (!needV) return cur instanceof Uint8ClampedArray && cur !== src ? cur : new Uint8ClampedArray(cur);
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let yy = 0; yy < dh; yy++) {
    const ymin = v.bounds[yy * 2];
    const ymax = v.bounds[yy * 2 + 1];
    const k = yy * v.ksize;
    for (let xx = 0; xx < curW; xx++) {
      let s0 = HALF, s1 = HALF, s2 = HALF;
      for (let y = 0; y < ymax; y++) {
        const p = ((y + ymin) * curW + xx) * 4;
        const w = v.kk[k + y];
        s0 += cur[p] * w;
        s1 += cur[p + 1] * w;
        s2 += cur[p + 2] * w;
      }
      const o = (yy * dw + xx) * 4;
      out[o] = clip8(s0);
      out[o + 1] = clip8(s1);
      out[o + 2] = clip8(s2);
      out[o + 3] = 255;
    }
  }
  void curH;
  return out;
}
