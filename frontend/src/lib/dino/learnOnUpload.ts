/**
 * Learn-on-upload for the DINO scan.
 *
 * Flow (agreed 2026-11-18):  original photo → DINO input prepared (imageProcessor, before compression;
 *                            v3: red ID text removed + cropped to the jewelry, see catalogCrop.ts)
 *                            → photo compressed + uploaded (unchanged) → THIS: model runs on that input
 *                            → fingerprint saved to the cloud.
 *
 * Why the model runs after the upload and not before: the model is the memory-heavy step. If a phone ever ran
 * out of memory here, the worst case is "photo saved, not learned yet" instead of losing the upload.
 *
 * Never throws and never blocks the caller. Anything that goes wrong leaves the item "waiting to be learned",
 * and Scan DINO learns it later from the stored 900px photo (agreed fallback).
 *
 * Photos are learned one at a time (queued), so a burst of uploads never runs the model twice at once.
 */
import { api } from '../../api';
import { DINO_MODEL_BYTES, DINO_MODEL_VERSION } from './config';
import { embedPixels, isDinoModelCached, loadDino } from './dinoClient';
import { NO_JEWELRY_ADVICE } from './catalogCrop';
import { withHeavyEngine } from '../heavyEngine';

export interface LearnJob {
  /** Item UUID (plated_jewelry.id) */
  itemUuid: string;
  /** Human item ID, for logs only */
  itemId: string;
  /** photo_etag the upload returned: the server only saves the fingerprint if the item still has exactly this photo */
  photoEtag: string | null | undefined;
  /** From processJewelryImage().dinoInput (transferred to the worker, unusable afterwards) */
  dinoInput: Float32Array | null;
  /** From processJewelryImage().dinoProblem: why dinoInput is missing */
  dinoProblem?: 'no_jewelry' | 'failed' | null;
}

/** no_jewelry: no jewelry found in the photo; never learned from the whole photo (agreed), item waits for a clearer photo */
export type LearnResult = 'learned' | 'skipped' | 'failed' | 'no_jewelry';

/** What the person should be told after a photo upload (null = nothing worth saying). */
export function learnResultMessage(result: LearnResult, itemId: string): { type: 'success' | 'info' | 'warning'; title: string; message: string } | null {
  if (result === 'learned') return { type: 'success', title: 'Ready to scan', message: `${itemId} can now be found with Scan.` };
  if (result === 'no_jewelry') {
    return {
      type: 'warning',
      title: 'Not ready to scan',
      message: `${itemId} is saved, but no jewelry was found in its photo, so Scan cannot learn it. ${NO_JEWELRY_ADVICE}`,
    };
  }
  if (result === 'failed') {
    return { type: 'warning', title: 'Not ready to scan yet', message: `${itemId} is saved, but Scan could not learn it now. It will be learned the next time Scan is opened.` };
  }
  return { type: 'info', title: 'Scan will learn it later', message: `${itemId} is saved. It will be learned for scanning the next time Scan is opened.` };
}

const DECLINED_KEY = 'dino_model_download_declined';
let queue: Promise<unknown> = Promise.resolve();

const declinedThisSession = () => {
  try {
    return sessionStorage.getItem(DECLINED_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * One-time question on a phone that has never downloaded the model (agreed: no silent 24 MB download).
 * A "No" is remembered until the app is closed, so a batch of uploads asks only once.
 */
async function modelAvailable(): Promise<boolean> {
  if (await isDinoModelCached()) return true;
  if (declinedThisSession() || !navigator.onLine) return false;
  const mb = Math.round(DINO_MODEL_BYTES / (1024 * 1024));
  const ok = window.confirm(
    `Download the scanner model (${mb} MB, one time) so new photos can be recognised by Scan?\n\n` +
      'If you skip, this photo is learned later from the saved photo when Scan is opened.'
  );
  if (!ok) {
    try {
      sessionStorage.setItem(DECLINED_KEY, '1');
    } catch {
      /* ignore */
    }
  }
  return ok;
}

async function learn(job: LearnJob): Promise<LearnResult> {
  if (job.dinoProblem === 'no_jewelry') return 'no_jewelry';
  if (!job.dinoInput || !job.photoEtag) return 'skipped';
  // Waits while the ID reader is reading (never both engines in memory at once)
  return withHeavyEngine(() => learnWithModel(job));
}

async function learnWithModel(job: LearnJob): Promise<LearnResult> {
  if (!job.dinoInput || !job.photoEtag) return 'skipped';
  try {
    if (!(await modelAvailable())) return 'skipped';
    await loadDino();
    const { vector } = await embedPixels(job.dinoInput);
    const res = await api.visualSearchDino.embed(DINO_MODEL_VERSION, [{ id: job.itemUuid, vector, photo_etag: job.photoEtag }], {
      onlyMissing: true,
    });
    if (res.embedded > 0) return 'learned';
    console.info(`[DINO] ${job.itemId} not saved:`, res.skipped);
    return 'skipped';
  } catch (err) {
    console.warn(`[DINO] Learning ${job.itemId} after upload failed (stays waiting, learned later):`, err);
    return 'failed';
  }
}

/** Queue a photo to be learned. Resolves when done; callers normally don't await it. */
export function learnAfterUpload(job: LearnJob): Promise<LearnResult> {
  const run = queue.then(() => learn(job));
  queue = run.catch(() => undefined);
  return run;
}
