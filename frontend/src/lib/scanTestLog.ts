/**
 * Visual search TEST log — temporary, testing phase only.
 *
 * Every scan is stored on this device (localStorage) so a whole test session can be
 * exported as one PDF report. No photos are stored, only numbers and AI attributes,
 * so 300 scans stay well under the ~5 MB localStorage limit.
 * Cost prices are never stored here.
 */
import type { JewelryAttributes, ScanCategory } from '../types';

const STORAGE_KEY = 'visual_search_test_log_v1'; // Llama (cloud) section
/** Separate storage for the on-device DINOv2 section: the two test sessions never mix. */
export const DINO_STORAGE_KEY = 'visual_search_dino_test_log_v1';
const MAX_RECORDS = 300;

export type ScanOutcome =
  | 'unmarked'
  | 'found' // correct item was in the top 6 (rank recorded)
  | 'not_in_top6' // correct item exists but was not returned
  | 'true_reject' // AI rejected and it really wasn't catalog jewelry
  | 'false_reject' // AI rejected a real catalog piece
  | 'false_accept' // non-catalog object still got matches
  | 'error';

export interface ScanMatchSummary {
  rank: number;
  id: string;
  item_id: string;
  score: number;
  category: string | null;
}

export interface ScanSelection {
  id: string;
  item_id: string;
  rank: number | null; // null when the item was not in the top 6
  score: number | null; // cosine(query, item) — computed even when not in the top 6
  category: string | null;
  indexed: boolean;
  attributes: JewelryAttributes | null;
  embedding_text: string | null;
}

export interface ScanTestRecord {
  id: string;
  /** Which feature produced this scan (missing = 'llama', for records saved before DINO existed). */
  pipeline?: 'llama' | 'dino';
  n: number;
  ts: string;
  source: 'camera' | 'gallery';
  prompt_version: string | null;
  category_filter: ScanCategory | null;
  image: { width: number; height: number; bytes: number };
  client_round_trip_ms: number | null;
  telemetry: {
    vision_ms?: number;
    embedding_ms?: number;
    vectorize_ms?: number;
    db_ms?: number;
    total_pipeline_ms?: number;
    vision_attempts?: number;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    // On-device (DINO) only
    preprocess_ms?: number;
    inference_ms?: number;
    compute_backend?: 'webgpu' | 'wasm';
    /** Set on the first scan after the model was loaded in this session. */
    model_load_ms?: number;
    model_from_cache?: boolean;
    model_download_ms?: number;
  };
  rejected: boolean;
  ai_attributes: JewelryAttributes | null;
  embedding_text: string | null;
  raw_vision_output: string | null;
  matches: ScanMatchSummary[];
  /** Catalog attributes of the #1 result, to compare against the phone photo when #1 was wrong. */
  top1_attributes: JewelryAttributes | null;
  filter_warning: string | null;
  outcome: ScanOutcome;
  selection: ScanSelection | null;
  reason: string;
  error: string | null;
}

export function loadScanLog(key: string = STORAGE_KEY): ScanTestRecord[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Returns false if the browser refused to save (private mode, storage full). */
export function saveScanLog(records: ScanTestRecord[], key: string = STORAGE_KEY): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(records.slice(-MAX_RECORDS)));
    return true;
  } catch {
    return false;
  }
}

export function clearScanLog(key: string = STORAGE_KEY): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (!a?.length || a.length !== b?.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─── Neuron (Workers AI usage) estimate ──────────────────────────────
// Cloudflare does not return neurons per request, only token counts. These are the
// published per-model rates (developers.cloudflare.com/workers-ai/platform/pricing,
// checked 2026-11-09). Neurons = tokens x rate / 1,000,000.
export const NEURON_RATES = {
  visionInputPerMillion: 4410, // llama-3.2-11b-vision-instruct, input tokens (prompt + image)
  visionOutputPerMillion: 61493, // llama-3.2-11b-vision-instruct, output tokens
  embeddingInputPerMillion: 1841, // bge-small-en-v1.5, input tokens
  freeDailyNeurons: 10000,
};

export interface NeuronEstimate {
  vision: number;
  embedding: number;
  total: number;
}

/**
 * Estimated neurons for one scan. Vision uses the real token counts the model reported
 * (summed over retries). The embedding text is ~30 tokens and BGE reports no usage, so
 * its tokens are approximated from text length (~4 chars per token); it is <1% of the total.
 * Returns null when the model reported no token counts.
 */
export function estimateNeurons(r: ScanTestRecord): NeuronEstimate | null {
  const p = r.telemetry.prompt_tokens;
  const c = r.telemetry.completion_tokens;
  if (typeof p !== 'number' && typeof c !== 'number') return null;
  const vision =
    ((p ?? 0) * NEURON_RATES.visionInputPerMillion + (c ?? 0) * NEURON_RATES.visionOutputPerMillion) / 1_000_000;
  const embedded = !r.rejected && r.outcome !== 'error' && r.embedding_text;
  const embedding = embedded
    ? ((Math.ceil(r.embedding_text!.length / 4) + 2) * NEURON_RATES.embeddingInputPerMillion) / 1_000_000
    : 0;
  return { vision, embedding, total: vision + embedding };
}

// ─── Summary statistics ──────────────────────────────────────────────

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export interface LatencyStats {
  avg: number | null;
  median: number | null;
  p95: number | null;
  max: number | null;
}

function latencyStats(values: (number | null | undefined)[]): LatencyStats {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return {
    avg: mean(v),
    median: percentile(v, 50),
    p95: percentile(v, 95),
    max: v.length ? Math.max(...v) : null,
  };
}

export interface ScanSummary {
  total: number;
  marked: number;
  unmarked: number;
  errors: number;
  /** Scans of real catalog jewelry with a known answer (found / not_in_top6 / false_reject). */
  catalogScans: number;
  rank1: number;
  top3: number;
  top6: number;
  notInTop6: number;
  falseReject: number;
  trueReject: number;
  falseAccept: number;
  latency: {
    roundTrip: LatencyStats;
    serverTotal: LatencyStats;
    vision: LatencyStats;
    embedding: LatencyStats;
    vectorize: LatencyStats;
    // On-device (DINO)
    preprocess: LatencyStats;
    inference: LatencyStats;
    modelLoadFirst: LatencyStats;
    modelLoadCached: LatencyStats;
  };
  /** Count of scans per on-device compute backend (DINO). */
  backends: { webgpu: number; wasm: number };
  avgPromptTokens: number | null;
  avgCompletionTokens: number | null;
  retries: number;
  /** Score of the #1 result when #1 was right vs when #1 was wrong — used to calibrate a reject threshold. */
  top1ScoreWhenCorrect: number | null;
  top1ScoreWhenWrong: number | null;
  avgCorrectItemScore: number | null;
  withChip: { scans: number; rank1: number; top6: number };
  withoutChip: { scans: number; rank1: number; top6: number };
  neurons: {
    scansWithTokens: number;
    scansWithoutTokens: number;
    total: number;
    avg: number | null;
    median: number | null;
    max: number | null;
    /** Share of the daily free allocation used by this whole session. */
    shareOfDailyFree: number;
    /** How many scans like the average one fit into the free daily allocation. */
    scansPerDayFree: number | null;
  };
}

export function summarize(records: ScanTestRecord[]): ScanSummary {
  const catalog = records.filter((r) => ['found', 'not_in_top6', 'false_reject'].includes(r.outcome));
  const rankOf = (r: ScanTestRecord) => (r.outcome === 'found' ? r.selection?.rank ?? null : null);
  const ok = (r: ScanTestRecord) => r.outcome !== 'error';

  const top1Right: number[] = [];
  const top1Wrong: number[] = [];
  for (const r of records) {
    if (!r.matches.length) continue;
    if (r.outcome === 'found' && r.selection?.rank === 1) top1Right.push(r.matches[0].score);
    else if (['found', 'not_in_top6', 'false_accept'].includes(r.outcome)) top1Wrong.push(r.matches[0].score);
  }

  const chipStats = (subset: ScanTestRecord[]) => ({
    scans: subset.length,
    rank1: subset.filter((r) => rankOf(r) === 1).length,
    top6: subset.filter((r) => rankOf(r) !== null).length,
  });

  const neuronValues = records
    .map((r) => estimateNeurons(r)?.total)
    .filter((x): x is number => typeof x === 'number');
  const neuronTotal = neuronValues.reduce((sum, v) => sum + v, 0);
  const neuronAvg = mean(neuronValues);

  return {
    total: records.length,
    marked: records.filter((r) => r.outcome !== 'unmarked' && r.outcome !== 'error').length,
    unmarked: records.filter((r) => r.outcome === 'unmarked').length,
    errors: records.filter((r) => r.outcome === 'error').length,
    catalogScans: catalog.length,
    rank1: catalog.filter((r) => rankOf(r) === 1).length,
    top3: catalog.filter((r) => (rankOf(r) ?? 99) <= 3).length,
    top6: catalog.filter((r) => rankOf(r) !== null).length,
    notInTop6: records.filter((r) => r.outcome === 'not_in_top6').length,
    falseReject: records.filter((r) => r.outcome === 'false_reject').length,
    trueReject: records.filter((r) => r.outcome === 'true_reject').length,
    falseAccept: records.filter((r) => r.outcome === 'false_accept').length,
    latency: {
      roundTrip: latencyStats(records.filter(ok).map((r) => r.client_round_trip_ms)),
      serverTotal: latencyStats(records.filter(ok).map((r) => r.telemetry.total_pipeline_ms)),
      vision: latencyStats(records.filter(ok).map((r) => r.telemetry.vision_ms)),
      embedding: latencyStats(records.filter(ok).map((r) => r.telemetry.embedding_ms)),
      vectorize: latencyStats(records.filter(ok).map((r) => r.telemetry.vectorize_ms)),
      preprocess: latencyStats(records.filter(ok).map((r) => r.telemetry.preprocess_ms)),
      inference: latencyStats(records.filter(ok).map((r) => r.telemetry.inference_ms)),
      modelLoadFirst: latencyStats(records.filter((r) => r.telemetry.model_from_cache === false).map((r) => r.telemetry.model_load_ms)),
      modelLoadCached: latencyStats(records.filter((r) => r.telemetry.model_from_cache === true).map((r) => r.telemetry.model_load_ms)),
    },
    backends: {
      webgpu: records.filter((r) => r.telemetry.compute_backend === 'webgpu').length,
      wasm: records.filter((r) => r.telemetry.compute_backend === 'wasm').length,
    },
    avgPromptTokens: mean(records.map((r) => r.telemetry.prompt_tokens).filter((x): x is number => typeof x === 'number')),
    avgCompletionTokens: mean(records.map((r) => r.telemetry.completion_tokens).filter((x): x is number => typeof x === 'number')),
    retries: records.filter((r) => (r.telemetry.vision_attempts ?? 1) > 1).length,
    top1ScoreWhenCorrect: mean(top1Right),
    top1ScoreWhenWrong: mean(top1Wrong),
    avgCorrectItemScore: mean(catalog.map((r) => r.selection?.score).filter((x): x is number => typeof x === 'number')),
    withChip: chipStats(catalog.filter((r) => r.category_filter)),
    withoutChip: chipStats(catalog.filter((r) => !r.category_filter)),
    neurons: {
      scansWithTokens: neuronValues.length,
      scansWithoutTokens: records.length - neuronValues.length,
      total: neuronTotal,
      avg: neuronAvg,
      median: percentile(neuronValues, 50),
      max: neuronValues.length ? Math.max(...neuronValues) : null,
      shareOfDailyFree: neuronTotal / NEURON_RATES.freeDailyNeurons,
      scansPerDayFree: neuronAvg && neuronAvg > 0 ? Math.floor(NEURON_RATES.freeDailyNeurons / neuronAvg) : null,
    },
  };
}
