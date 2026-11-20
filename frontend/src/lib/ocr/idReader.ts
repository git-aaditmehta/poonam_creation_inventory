/**
 * "Read ID from photo" (agreed 2026-11-20): fills the Design Code field from the red ID printed on catalog photos.
 *
 *   photo -> 900px working copy (same as the scanner) -> the red ID text line (same finder as the text remover,
 *   catalogCropCore.findTextLine) -> black-on-white strip -> Tesseract OCR on this device -> format check
 *
 * Test O on the 79 sample photos: 79/79 read exactly right, ~6 ms per photo on a laptop after a ~0.15 s start.
 * Off by default (a switch in the add-item form). Engine files (~7 MB) come from our own site (/ocr/v6, see
 * vite.config.ts) and are kept on the device by the service worker once downloaded.
 *
 * Memory (agreed design "read all IDs first, then close"): a batch runs inside withHeavyEngine — the scanner model
 * is unloaded first, all IDs are read, then the engine is closed — so the two heavy engines never share memory.
 */
import { getJewelryTypes } from '../../utils/jewelryCategory';
import { findTextLine } from '../dino/catalogCropCore';
import { workCopy } from '../dino/catalogCrop';
import { unloadDino } from '../dino/dinoClient';
import { withHeavyEngine } from '../heavyEngine';

/** Keep in sync with OCR_BASE in vite.config.ts and sw/sw-template.js */
export const OCR_BASE = '/ocr/v6';
export const OCR_DOWNLOAD_MB = 7;
const SWITCH_KEY = 'read_id_from_photo';

export function isIdReaderOn(): boolean {
  try {
    return localStorage.getItem(SWITCH_KEY) === '1';
  } catch {
    return false;
  }
}
export function setIdReaderOn(on: boolean): void {
  try {
    if (on) localStorage.setItem(SWITCH_KEY, '1');
    else localStorage.removeItem(SWITCH_KEY);
  } catch {
    /* remembered for this session only */
  }
}

// Letters OCR may confuse with digits, fixed only in the number part ("PS 3G7" -> "PS 367")
const AS_DIGIT: Record<string, string> = { O: '0', D: '0', Q: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', B: '8', G: '6' };

/**
 * The first "<known prefix> <number>" in the text, e.g. "PS 376(PCJ 8)" -> "PS 376". Prefixes are the jewelry types
 * (utils/jewelryCategory.ts, including types the owner adds later), so a new type is read too. Anything else -> null (left empty:
 * a wrong ID is worse than an empty field).
 */
export function parseItemId(text: string, prefixes: string[] = getJewelryTypes().map((t) => t.prefix)): string | null {
  const t = (text || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
  const alt = prefixes.map((p) => p.toUpperCase().replace(/[^A-Z]/g, '')).filter(Boolean).join('|');
  if (!alt) return null;
  const m = t.match(new RegExp(`(?:^|[^A-Z])(${alt})\\s*([0-9ODQILTZSBG]{1,4})(?![A-Z0-9])`));
  if (!m) return null;
  const num = m[2].split('').map((c) => AS_DIGIT[c] ?? c).join('');
  return /^\d{1,4}$/.test(num) ? `${m[1]} ${Number(num)}` : null;
}

type TWorker = { recognize: (img: HTMLCanvasElement) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> };
let worker: TWorker | null = null;
let loading: Promise<TWorker> | null = null;

async function getWorker(): Promise<TWorker> {
  if (worker) return worker;
  if (!loading) {
    loading = (async () => {
      const mod: any = await import('tesseract.js');
      const T = mod.createWorker ? mod : mod.default;
      const w = await T.createWorker('eng', T.OEM?.LSTM_ONLY ?? 1, {
        workerPath: `${OCR_BASE}/worker.min.js`,
        corePath: OCR_BASE,
        langPath: OCR_BASE,
        gzip: true,
        cacheMethod: 'none', // the service worker keeps the files; no second copy in IndexedDB
        workerBlobURL: false,
      });
      await w.setParameters({ tessedit_pageseg_mode: T.PSM?.SINGLE_LINE ?? '7', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ()' });
      worker = w as TWorker;
      return worker;
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

/** Closes the engine and gives its memory back (the downloaded files stay on the device). */
export async function closeIdReader(): Promise<void> {
  const w = worker;
  worker = null;
  loading = null;
  if (w) await w.terminate().catch(() => undefined);
}

export type IdReadResult = { id: string } | { id: null; reason: 'no_text' | 'unreadable' | 'error'; message?: string };

async function readOne(file: Blob): Promise<IdReadResult> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let work: ReturnType<typeof workCopy>;
  try {
    work = workCopy(bmp, bmp.width, bmp.height);
  } finally {
    bmp.close();
  }
  const strip = findTextLine(work.data, work.width, work.height);
  if (!strip) return { id: null, reason: 'no_text' };
  const canvas = document.createElement('canvas');
  canvas.width = strip.width;
  canvas.height = strip.height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context');
    const img = ctx.createImageData(strip.width, strip.height);
    for (let i = 0; i < strip.gray.length; i++) {
      const v = strip.gray[i];
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const r = await (await getWorker()).recognize(canvas);
    const id = parseItemId(r.data.text);
    return id ? { id } : { id: null, reason: 'unreadable' };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

export interface ReadBatchControl {
  cancelled: boolean;
}

/**
 * Reads the IDs of all given photos in one go, then closes the engine. Never throws for a single photo
 * (its result says why); throws only if the engine itself cannot start (e.g. offline before the first download).
 */
export function readIds(
  files: { key: string; file: Blob }[],
  onResult: (key: string, result: IdReadResult) => void,
  onProgress: (done: number, total: number, phase: 'starting' | 'reading') => void,
  control: ReadBatchControl
): Promise<void> {
  return withHeavyEngine(async () => {
    if (control.cancelled || !files.length) return;
    unloadDino(); // never both engines in memory
    try {
      onProgress(0, files.length, 'starting');
      await getWorker();
      let done = 0;
      for (const f of files) {
        if (control.cancelled) break;
        let r: IdReadResult;
        try {
          r = await readOne(f.file);
        } catch (e: any) {
          r = { id: null, reason: 'error', message: e?.message || 'failed' };
        }
        if (control.cancelled) break;
        onResult(f.key, r);
        onProgress(++done, files.length, 'reading');
      }
    } finally {
      await closeIdReader();
    }
  });
}

/** Switching on: downloads the engine once (about 7 MB) and checks it starts, then closes it again. */
export function prepareIdReader(): Promise<void> {
  return withHeavyEngine(async () => {
    unloadDino();
    try {
      await getWorker();
    } finally {
      await closeIdReader();
    }
  });
}
