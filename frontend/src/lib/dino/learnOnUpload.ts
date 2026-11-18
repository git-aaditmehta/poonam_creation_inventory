/**
 * Learn-on-upload for the DINO scan.
 *
 * Flow (agreed 2026-11-18):  original photo → DINO input prepared (imageProcessor, before compression)
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

export interface LearnJob {
  /** Item UUID (plated_jewelry.id) */
  itemUuid: string;
  /** Human item ID, for logs only */
  itemId: string;
  /** photo_etag the upload returned: the server only saves the fingerprint if the item still has exactly this photo */
  photoEtag: string | null | undefined;
  /** From processJewelryImage().dinoInput (transferred to the worker, unusable afterwards) */
  dinoInput: Float32Array | null;
}

export type LearnResult = 'learned' | 'skipped' | 'failed';

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
      'If you skip, this photo is learned later from the saved photo when Scan DINO is opened.'
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
