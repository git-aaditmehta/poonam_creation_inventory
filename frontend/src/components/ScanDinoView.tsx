/**
 * Scan DINO — on-device visual search (DINOv2-small), a separate feature from "Scan Jewelry" (Llama).
 *
 * Flow: photo → padded square 224px → DINOv2 on this device (Web Worker) → 384 numbers
 *       → /api/visual-search-dino/search → Vectorize (jewelry-dinov2-384) → top 6.
 * No Workers AI is used. Catalog photos are learned on the owner's device and stored in the cloud,
 * so every phone searches the same fingerprints.
 *
 * Shares nothing at runtime with ScanJewelryView: own endpoints, own index, own test log storage.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Cpu,
  Camera,
  RefreshCw,
  Upload,
  Zap,
  ZapOff,
  SwitchCamera,
  AlertTriangle,
  Layers,
  ArrowUpDown,
  X,
  Package,
  WifiOff,
  ChevronDown,
  ChevronUp,
  Sliders,
  RotateCcw,
  FileText,
  Check,
  Search,
  Trash2,
  Download,
} from 'lucide-react';
import { api } from '../api';
import { localDb } from '../lib/localDb';
import type { User, PlatedJewelryItem, ScanCategory, DinoMatch, DinoSearchResponse, DinoStatusResponse } from '../types';
import { useToast } from '../context/ToastContext';
import {
  DINO_STORAGE_KEY,
  loadScanLog,
  saveScanLog,
  clearScanLog,
  cosineSimilarity,
  summarize,
  type ScanTestRecord,
  type ScanOutcome,
} from '../lib/scanTestLog';
import { generateScanTestReport } from '../utils/scanReportPdf';
import { DINO_MODEL_BYTES, DINO_MODEL_VERSION } from '../lib/dino/config';
import { embedImage, loadCatalogBitmap, loadDino, type DinoLoadInfo } from '../lib/dino/dinoClient';

interface ScanDinoViewProps {
  user: User;
  onQuickOperate?: (category: 'plated_jewelry', item: any) => void;
}

const CATEGORY_CHIPS: { value: ScanCategory | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'earring', label: 'Earring (ER)' },
  { value: 'stud', label: 'Stud (PS)' },
  { value: 'jhumka', label: 'Jhumka (JK)' },
  { value: 'bracelet', label: 'Bracelet (BR)' },
  { value: 'pendant_set', label: 'Pendant set (PD)' },
];

const EMBED_BATCH = 5; // vectors per /embed request (saved often, so a crash loses little)
/** Set while learning runs; if it is still set when the tab opens, the last run crashed (e.g. out of memory). */
const LEARNING_FLAG_KEY = 'dino_learning_active';
/** Auto-learn only small batches (new uploads); big batches need a tap, ideally on a laptop. */
const AUTO_LEARN_MAX = 10;

const readLearningFlag = () => {
  try {
    return localStorage.getItem(LEARNING_FLAG_KEY);
  } catch {
    return null;
  }
};
const writeLearningFlag = (on: boolean) => {
  try {
    if (on) localStorage.setItem(LEARNING_FLAG_KEY, new Date().toISOString());
    else localStorage.removeItem(LEARNING_FLAG_KEY);
  } catch {
    /* ignore */
  }
};
const PREVIEW_MAX = 768; // preview image only (never sent anywhere)

type PickerMode = 'not_in_top6';
type ModelState = 'idle' | 'loading' | 'ready' | 'error';

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

export const ScanDinoView: React.FC<ScanDinoViewProps> = ({ user, onQuickOperate }) => {
  const isOwner = user.role === 'owner';
  const { showToast } = useToast();

  // ── Connectivity ──
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // ── Model ──
  const [modelState, setModelState] = useState<ModelState>('idle');
  const [modelProgress, setModelProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [loadInfo, setLoadInfo] = useState<DinoLoadInfo | null>(null);
  const loadInfoReportedRef = useRef(false); // attach model-load timing to the first scan only

  // ── Camera ──
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // ── Search ──
  const [category, setCategory] = useState<ScanCategory | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [capturedPreview, setCapturedPreview] = useState<string | null>(null);
  const [response, setResponse] = useState<DinoSearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const queryVectorRef = useRef<number[] | null>(null);

  // ── Test log (separate storage from the Llama section) ──
  const [records, setRecords] = useState<ScanTestRecord[]>(() => loadScanLog(DINO_STORAGE_KEY));
  const [currentRecordId, setCurrentRecordId] = useState<string | null>(null);
  const [reasonDraft, setReasonDraft] = useState('');
  const currentRecord = records.find((r) => r.id === currentRecordId) || null;
  const summary = summarize(records);

  // ── Correct-item picker ──
  const [pickerMode, setPickerMode] = useState<PickerMode | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerResults, setPickerResults] = useState<PlatedJewelryItem[]>([]);
  const [pickerBusy, setPickerBusy] = useState(false);

  // ── Lightbox ──
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // ── Catalog learning (owner) ──
  const [status, setStatus] = useState<DinoStatusResponse | null>(null);
  const [showIndexPanel, setShowIndexPanel] = useState(false);
  const [isLearning, setIsLearning] = useState(false);
  const [learnProgress, setLearnProgress] = useState<{ done: number; total: number } | null>(null);
  const [learnErrors, setLearnErrors] = useState<string[]>([]);
  const stopLearnRef = useRef(false);
  const autoLearnTriedRef = useRef(false);
  const [crashedLastTime] = useState(() => Boolean(readLearningFlag()));

  // ═══ Model loading ═══
  const startModel = useCallback(async () => {
    setModelState('loading');
    setModelError(null);
    try {
      const info = await loadDino((loaded, total) => setModelProgress({ loaded, total }));
      setLoadInfo(info);
      setModelState('ready');
    } catch (err: any) {
      setModelError(err?.message || 'Could not load the model');
      setModelState('error');
    }
  }, []);

  useEffect(() => {
    startModel();
  }, [startModel]);

  // ═══ Status ("N new items waiting to be learned") ═══
  const fetchStatus = useCallback(async () => {
    try {
      setStatus(await api.visualSearchDino.status());
    } catch {
      /* offline or server error: banner just doesn't show */
    }
  }, []);

  useEffect(() => {
    if (isOnline) fetchStatus();
  }, [isOnline, fetchStatus]);

  // ═══ Camera ═══
  const startCamera = useCallback(
    async (mode: 'environment' | 'user') => {
      setCameraError(null);
      try {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: mode, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        setStream(newStream);
        setCameraActive(true);
        if (videoRef.current) {
          videoRef.current.srcObject = newStream;
          videoRef.current.play().catch(() => undefined);
        }
        const track = newStream.getVideoTracks()[0];
        const caps: any = track?.getCapabilities ? track.getCapabilities() : {};
        setHasTorch(Boolean(caps.torch));
      } catch (err: any) {
        setCameraActive(false);
        let msg = 'Unable to access camera.';
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          msg = 'Camera permission denied. Please allow camera access in your browser settings.';
        } else if (err.name === 'NotFoundError') {
          msg = 'No camera found on this device.';
        } else if (err.name === 'NotReadableError') {
          msg = 'Camera is currently in use by another application.';
        }
        setCameraError(msg);
      }
    },
    [stream]
  );

  const stopCamera = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
    }
    setCameraActive(false);
    setTorchOn(false);
  }, [stream]);

  useEffect(() => {
    startCamera(facingMode);
    return () => stopCamera();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (cameraActive && stream && videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => undefined);
    }
  });

  const handleToggleFacingMode = () => {
    const next = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(next);
    startCamera(next);
  };

  const handleToggleTorch = async () => {
    const track = stream?.getVideoTracks()[0];
    if (!track || !hasTorch) return;
    try {
      await (track as any).applyConstraints({ advanced: [{ torch: !torchOn }] });
      setTorchOn(!torchOn);
    } catch {
      /* torch not supported */
    }
  };

  // ═══ Test log helpers ═══
  const updateRecords = (updater: (prev: ScanTestRecord[]) => ScanTestRecord[]) => {
    setRecords((prev) => {
      const next = updater(prev);
      if (!saveScanLog(next, DINO_STORAGE_KEY)) {
        showToast('warning', 'Not saved', 'This browser blocked saving the test log (private mode or storage full).');
      }
      return next;
    });
  };

  const patchCurrent = (patch: Partial<ScanTestRecord>) => {
    if (!currentRecordId) return;
    updateRecords((prev) => prev.map((r) => (r.id === currentRecordId ? { ...r, ...patch } : r)));
  };

  // ═══ Search ═══
  /** Camera: the square the viewfinder shows. Gallery: the whole photo (padded to a square on embedding). */
  const cropRect = (srcW: number, srcH: number, square: boolean) => {
    if (!square) return { sx: 0, sy: 0, sw: srcW, sh: srcH };
    const side = Math.min(srcW, srcH);
    return { sx: (srcW - side) / 2, sy: (srcH - side) / 2, sw: side, sh: side };
  };

  const performSearch = async (source: HTMLVideoElement | HTMLImageElement, srcW: number, srcH: number, from: 'camera' | 'gallery') => {
    if (!isOnline) {
      showToast('error', 'Offline', 'Search needs an internet connection.');
      return;
    }
    if (modelState !== 'ready') {
      showToast('warning', 'Model not ready', 'Wait for the model to finish loading.');
      return;
    }
    const tTap = performance.now();
    const crop = cropRect(srcW, srcH, from === 'camera');

    // Small preview for the screen only (freed right after; iOS has a hard canvas-memory limit)
    const pScale = Math.min(1, PREVIEW_MAX / Math.max(crop.sw, crop.sh));
    const preview = document.createElement('canvas');
    preview.width = Math.round(crop.sw * pScale);
    preview.height = Math.round(crop.sh * pScale);
    preview.getContext('2d')?.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, preview.width, preview.height);
    setCapturedPreview(preview.toDataURL('image/jpeg', 0.8));
    preview.width = 0;
    preview.height = 0;

    setIsSearching(true);
    setSearchError(null);
    setResponse(null);
    setPickerMode(null);
    setReasonDraft('');
    queryVectorRef.current = null;
    if (navigator.vibrate) navigator.vibrate(40);

    const firstScanLoad =
      !loadInfoReportedRef.current && loadInfo
        ? { model_load_ms: loadInfo.loadMs, model_from_cache: loadInfo.fromCache, model_download_ms: loadInfo.downloadMs }
        : {};
    loadInfoReportedRef.current = true;

    const base: ScanTestRecord = {
      id: newId(),
      pipeline: 'dino',
      n: (records[records.length - 1]?.n ?? 0) + 1,
      ts: new Date().toISOString(),
      source: from,
      prompt_version: DINO_MODEL_VERSION,
      category_filter: category,
      image: { width: Math.round(crop.sw), height: Math.round(crop.sh), bytes: 0 },
      client_round_trip_ms: null,
      telemetry: { compute_backend: loadInfo?.backend, ...firstScanLoad },
      rejected: false,
      ai_attributes: null,
      embedding_text: null,
      raw_vision_output: null,
      matches: [],
      top1_attributes: null,
      filter_warning: null,
      outcome: 'unmarked',
      selection: null,
      reason: '',
      error: null,
    };

    let emb: Awaited<ReturnType<typeof embedImage>> | null = null;
    try {
      emb = await embedImage(source, crop); // same frame as the preview (both drawn synchronously)
      queryVectorRef.current = emb.vector;
      const res = await api.visualSearchDino.search(DINO_MODEL_VERSION, emb.vector, category);
      const roundTrip = Math.round(performance.now() - tTap);
      setResponse(res);
      const record: ScanTestRecord = {
        ...base,
        prompt_version: res.model_version || DINO_MODEL_VERSION,
        client_round_trip_ms: roundTrip,
        telemetry: {
          ...base.telemetry,
          preprocess_ms: emb.preprocessMs,
          inference_ms: emb.inferenceMs,
          vectorize_ms: res.telemetry?.vectorize_ms,
          db_ms: res.telemetry?.db_ms,
          total_pipeline_ms: res.telemetry?.total_ms,
        },
        matches: (res.matches || []).map((m, i) => ({
          rank: i + 1,
          id: m.id,
          item_id: m.item_id,
          score: m.score,
          category: m.match_category ?? null,
        })),
        filter_warning: res.filter_warning || null,
      };
      updateRecords((prev) => [...prev, record]);
      setCurrentRecordId(record.id);
      if (res.filter_warning) showToast('warning', 'Category filter', res.filter_warning);
    } catch (err: any) {
      const message = err?.data?.error || err?.message || 'Search failed';
      setSearchError(message);
      const record: ScanTestRecord = {
        ...base,
        client_round_trip_ms: Math.round(performance.now() - tTap),
        telemetry: { ...base.telemetry, preprocess_ms: emb?.preprocessMs, inference_ms: emb?.inferenceMs },
        outcome: 'error',
        error: `${err?.status || ''} ${message}`.trim(),
      };
      updateRecords((prev) => [...prev, record]);
      setCurrentRecordId(record.id);
    } finally {
      setIsSearching(false);
    }
  };

  const handleCapture = () => {
    const video = videoRef.current;
    if (!video || !cameraActive) return;
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      showToast('warning', 'Camera not ready', 'Please wait for the camera feed to start.');
      return;
    }
    performSearch(video, video.videoWidth, video.videoHeight, 'camera');
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('error', 'Invalid file', 'Please select an image (JPEG, PNG, WebP).');
      return;
    }
    const url = URL.createObjectURL(file);
    const el = new Image();
    el.onload = () => {
      performSearch(el, el.naturalWidth, el.naturalHeight, 'gallery').finally(() => URL.revokeObjectURL(url));
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      showToast('error', 'Image processing failed', 'Could not read this photo.');
    };
    el.src = url;
  };

  const handleReset = () => {
    setCapturedPreview(null);
    setResponse(null);
    setSearchError(null);
    setPickerMode(null);
    setCurrentRecordId(null);
    setReasonDraft('');
    queryVectorRef.current = null;
    if (!cameraActive) startCamera(facingMode);
  };

  // ═══ Feedback marking ═══
  const setOutcome = (outcome: ScanOutcome, selection: ScanTestRecord['selection']) => {
    patchCurrent({ outcome, selection });
    setPickerMode(null);
  };

  const handleMarkMatch = (match: DinoMatch, idx: number) => {
    if (!currentRecord) return;
    if (currentRecord.outcome === 'found' && currentRecord.selection?.id === match.id) {
      setOutcome('unmarked', null); // tap again = undo
      return;
    }
    setOutcome('found', {
      id: match.id,
      item_id: match.item_id,
      rank: idx + 1,
      score: match.score,
      category: match.match_category ?? null,
      indexed: true,
      attributes: null,
      embedding_text: null,
    });
  };

  const handleToggleFalseAccept = () => {
    if (!currentRecord) return;
    setOutcome(currentRecord.outcome === 'false_accept' ? 'unmarked' : 'false_accept', null);
  };

  useEffect(() => {
    if (!pickerMode) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const items = await localDb.getAllItems<PlatedJewelryItem>('plated_jewelry', pickerQuery || undefined);
        if (!cancelled) setPickerResults(items.filter((i) => i.image_key).slice(0, 40));
      } catch {
        if (!cancelled) setPickerResults([]);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [pickerMode, pickerQuery]);

  const handlePickCorrectItem = async (item: PlatedJewelryItem) => {
    if (!pickerMode) return;
    const inResults = response?.matches.findIndex((m) => m.id === item.id) ?? -1;
    if (inResults >= 0 && response) {
      handleMarkMatch(response.matches[inResults], inResults);
      return;
    }
    setPickerBusy(true);
    let indexed = false;
    let score: number | null = null;
    let cat: string | null = null;
    try {
      const d = await api.visualSearchDino.descriptor(item.id);
      indexed = d.indexed;
      cat = d.category ?? null;
      if (d.values && queryVectorRef.current) score = cosineSimilarity(queryVectorRef.current, d.values);
    } catch {
      showToast('warning', 'Partial info', 'Could not load this item’s fingerprint; saved without its score.');
    } finally {
      setPickerBusy(false);
    }
    setOutcome(pickerMode, {
      id: item.id,
      item_id: item.item_id,
      rank: null,
      score,
      category: cat,
      indexed,
      attributes: null,
      embedding_text: null,
    });
    if (!indexed) showToast('warning', 'Not learned yet', `${item.item_id} has not been learned by DINO, so search could never find it.`);
  };

  const handleSaveReason = () => {
    if (currentRecord && reasonDraft !== currentRecord.reason) patchCurrent({ reason: reasonDraft.trim() });
  };

  // ═══ Report ═══
  const handleDownloadReport = () => {
    if (!records.length) return;
    try {
      generateScanTestReport(records, 'dino');
    } catch (err: any) {
      showToast('error', 'Report failed', err.message || 'Could not build the PDF.');
    }
  };

  const handleClearSession = () => {
    if (!records.length) return;
    if (!window.confirm(`Delete all ${records.length} DINO test scans on this device? Download the report first if you need it.`)) return;
    clearScanLog(DINO_STORAGE_KEY);
    setRecords([]);
    setCurrentRecordId(null);
  };

  // ═══ Owner: learn catalog photos on this device ═══
  const learnPending = useCallback(async () => {
    if (!isOwner || isLearning) return;
    setIsLearning(true);
    stopLearnRef.current = false;
    setLearnErrors([]);
    writeLearningFlag(true);
    try {
      await loadDino((loaded, total) => setModelProgress({ loaded, total }));
      const { items } = await api.visualSearchDino.pending();
      if (!items.length) {
        showToast('success', 'All learned', 'Every catalog photo is already learned.');
        return;
      }
      setLearnProgress({ done: 0, total: items.length });
      let batch: { id: string; vector: number[] }[] = [];
      let done = 0;
      let failed = 0;
      const flush = async () => {
        if (!batch.length) return;
        const res = await api.visualSearchDino.embed(DINO_MODEL_VERSION, batch);
        if (res.skipped?.length) setLearnErrors((prev) => [...prev, ...res.skipped.map((s) => `${s.id}: ${s.reason}`)].slice(-8));
        batch = [];
      };
      for (const it of items) {
        if (stopLearnRef.current) break;
        try {
          const bmp = await loadCatalogBitmap(api.images.getUrl(it.image_key, it.updated_at));
          try {
            const emb = await embedImage(bmp, { sx: 0, sy: 0, sw: bmp.width, sh: bmp.height });
            batch.push({ id: it.id, vector: emb.vector });
          } finally {
            bmp.close();
          }
          if (batch.length >= EMBED_BATCH) await flush();
        } catch (err: any) {
          failed++;
          setLearnErrors((prev) => [...prev, `${it.item_id}: ${err?.message || 'failed'}`].slice(-8));
          // Server-side failures (auth, version mismatch) affect every item → stop instead of looping
          if (err?.status === 401 || err?.status === 403 || err?.status === 409) {
            stopLearnRef.current = true;
          }
        }
        done++;
        setLearnProgress({ done, total: items.length });
        await new Promise((r) => setTimeout(r, 30)); // let the browser breathe / free memory between photos
      }
      await flush();
      if (stopLearnRef.current) showToast('info', 'Learning paused', `${done} of ${items.length} processed.`);
      else if (failed) showToast('warning', 'Learning finished with errors', `${failed} photo(s) failed; they stay waiting.`);
      else showToast('success', 'Learning complete', `${items.length} photo(s) learned.`);
    } catch (err: any) {
      showToast('error', 'Learning failed', err?.data?.error || err?.message || 'Unknown error');
    } finally {
      writeLearningFlag(false);
      setIsLearning(false);
      fetchStatus();
    }
  }, [isOwner, isLearning, fetchStatus, showToast]);

  // New uploads: when the owner opens this tab and the model is ready, learn waiting items automatically.
  useEffect(() => {
    if (!isOwner || autoLearnTriedRef.current || crashedLastTime) return;
    if (modelState !== 'ready' || !status || status.pending === 0 || status.pending > AUTO_LEARN_MAX || !isOnline) return;
    autoLearnTriedRef.current = true;
    learnPending();
  }, [isOwner, modelState, status, isOnline, learnPending, crashedLastTime]);

  const handleRelearnAll = async () => {
    if (!window.confirm('Re-learn every catalog photo on this device? (Free: no AI quota is used.)')) return;
    try {
      const res = await api.visualSearchDino.reindexReset();
      showToast('info', 'Re-learn started', `${res.reset} photos marked to re-learn.`);
      await fetchStatus();
      learnPending();
    } catch (err: any) {
      showToast('error', 'Reset failed', err.message);
    }
  };

  // ═══ Render helpers ═══
  const matches = response?.matches || [];
  const ready = modelState === 'ready';
  const outcomeBanner = (() => {
    if (!currentRecord) return null;
    const r = currentRecord;
    switch (r.outcome) {
      case 'found':
        return `Saved: correct item ${r.selection?.item_id} at #${r.selection?.rank}`;
      case 'not_in_top6':
        return r.selection
          ? `Saved: not in top 6 (correct: ${r.selection.item_id}${r.selection.score !== null ? `, score ${r.selection.score.toFixed(3)}` : ''})`
          : 'Saved: not in top 6';
      case 'false_accept':
        return 'Saved: not a catalog item';
      case 'error':
        return `Saved as error: ${r.error}`;
      default:
        return null;
    }
  })();

  const pct = modelProgress && modelProgress.total ? Math.min(100, Math.round((modelProgress.loaded / modelProgress.total) * 100)) : 0;

  // ═══ Render ═══
  return (
    <div className="sj-root">
      {/* Header */}
      <div className="sj-header">
        <div className="sj-title">
          <Cpu size={20} />
          <span>Scan DINO</span>
          <span className="sj-badge">Test · on-device</span>
        </div>
        {isOwner && (
          <button className="btn btn-secondary sj-small-btn" onClick={() => setShowIndexPanel(!showIndexPanel)}>
            <Sliders size={14} /> Catalog {showIndexPanel ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>

      {/* Model status */}
      {modelState === 'loading' && (
        <div className="sj-card">
          <div className="sj-row" style={{ fontWeight: 600 }}>
            <Download size={16} />
            {modelProgress && modelProgress.loaded > 0
              ? `Downloading the DINO model… ${mb(modelProgress.loaded)} / ${mb(modelProgress.total || DINO_MODEL_BYTES)} MB`
              : 'Loading the DINO model…'}
          </div>
          <div className="sd-progress"><div style={{ width: `${pct}%` }} /></div>
          <div className="sj-small sj-muted">First time only ({mb(DINO_MODEL_BYTES)} MB, best on wifi). After that it opens from this phone in about a second.</div>
        </div>
      )}
      {modelState === 'error' && (
        <div className="sj-alert sj-alert-red">
          <AlertTriangle size={18} />
          <div>
            <strong>Model could not load.</strong> {modelError}
            <div style={{ marginTop: 6 }}>
              <button className="btn btn-secondary sj-small-btn" onClick={startModel}>
                <RefreshCw size={12} /> Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {isOwner && crashedLastTime && !isLearning && (
        <div className="sj-alert sj-alert-amber">
          <AlertTriangle size={18} />
          <div>
            <strong>Learning stopped unexpectedly last time</strong> (the browser probably ran out of memory and reloaded).
            Progress is saved every 5 photos. Tap <b>Learn now</b> to continue, or use a laptop for big batches.
          </div>
        </div>
      )}

      {/* "N new items waiting to be learned" */}
      {status && status.pending > 0 && (
        <div className="sj-alert sj-alert-amber">
          <AlertTriangle size={18} />
          <div>
            <strong>
              {status.pending} new item{status.pending === 1 ? '' : 's'} waiting to be learned
            </strong>
            {isOwner ? (
              isLearning ? (
                <div className="sj-small">Learning on this device… {learnProgress ? `${learnProgress.done}/${learnProgress.total}` : ''}</div>
              ) : (
                <div style={{ marginTop: 6 }}>
                  <button className="btn btn-primary sj-small-btn" onClick={learnPending} disabled={!ready || !isOnline}>
                    Learn now
                  </button>
                </div>
              )
            ) : (
              <div className="sj-small">Scan can’t find these yet. Ask the owner to open Scan DINO once.</div>
            )}
          </div>
        </div>
      )}

      {/* Test session bar */}
      <div className="sj-session">
        <div className="sj-session-stats">
          <strong>{records.length}</strong> scans
          {summary.catalogScans > 0 && (
            <>
              {' · '}#1 {Math.round((summary.rank1 / summary.catalogScans) * 100)}% · top 3{' '}
              {Math.round((summary.top3 / summary.catalogScans) * 100)}%
            </>
          )}
          {summary.unmarked > 0 && <span className="sj-muted"> · {summary.unmarked} unmarked</span>}
        </div>
        <div className="sj-session-actions">
          <button className="btn btn-secondary sj-small-btn" disabled={!records.length} onClick={handleDownloadReport}>
            <FileText size={14} /> Report
          </button>
          <button className="btn btn-secondary sj-small-btn" disabled={!records.length} onClick={handleClearSession} title="Clear test session">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {!isOnline && (
        <div className="sj-alert sj-alert-red">
          <WifiOff size={18} /> Search needs an internet connection.
        </div>
      )}

      {/* Owner catalog panel */}
      {isOwner && showIndexPanel && (
        <div className="sj-card">
          <div className="sj-row-between">
            <strong>DINO catalog</strong>
            <button className="btn btn-secondary sj-small-btn" onClick={fetchStatus}>
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
          {status ? (
            <>
              <div className="sj-stat-grid">
                <div><span>With photo</span><b>{status.with_images}</b></div>
                <div><span>Learned</span><b>{status.indexed}</b></div>
                <div><span>Waiting</span><b>{status.pending}</b></div>
                <div><span>Device</span><b>{loadInfo ? (loadInfo.backend === 'webgpu' ? 'GPU' : 'CPU') : '-'}</b></div>
              </div>
              <div className="sj-muted sj-small">Model: {status.model_version} · learning runs on this device, uses no AI quota</div>
              {learnProgress && <div className="sj-small">Learned {learnProgress.done} / {learnProgress.total} this run</div>}
              {learnErrors.length > 0 && (
                <ul className="sj-errors">
                  {learnErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
              <div className="sj-btn-row">
                {isLearning ? (
                  <button className="btn btn-secondary" onClick={() => { stopLearnRef.current = true; }}>
                    Pause
                  </button>
                ) : (
                  <>
                    <button className="btn btn-primary" onClick={learnPending} disabled={!ready || status.pending === 0}>
                      Index catalog ({status.pending})
                    </button>
                    <button className="btn btn-secondary" onClick={handleRelearnAll} disabled={!ready}>
                      Re-learn all
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="sj-muted sj-small">Loading…</div>
          )}
        </div>
      )}

      {/* Category chips */}
      <div className="sj-chips" role="radiogroup" aria-label="Category filter">
        {CATEGORY_CHIPS.map((c) => (
          <button
            key={c.label}
            className={`sj-chip ${category === c.value ? 'active' : ''}`}
            onClick={() => setCategory(c.value)}
            disabled={isSearching}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="sj-grid">
        {/* Viewfinder column */}
        <div>
          <div className="sj-viewfinder">
            {capturedPreview ? (
              <img src={capturedPreview} alt="Scanned photo" className="sj-fill" style={{ objectFit: 'contain', background: '#000' }} />
            ) : cameraActive ? (
              <>
                <video ref={videoRef} playsInline autoPlay muted className="sj-fill" style={{ objectFit: 'cover' }} />
                <div className="sj-reticle" />
                <div className="sj-cam-controls">
                  {hasTorch && (
                    <button onClick={handleToggleTorch} className={`sj-round-btn ${torchOn ? 'on' : ''}`} aria-label="Flashlight">
                      {torchOn ? <Zap size={18} /> : <ZapOff size={18} />}
                    </button>
                  )}
                  <button onClick={handleToggleFacingMode} className="sj-round-btn" aria-label="Switch camera">
                    <SwitchCamera size={18} />
                  </button>
                </div>
              </>
            ) : (
              <div className="sj-cam-off">
                <Camera size={40} />
                <div>{cameraError || 'Camera is stopped'}</div>
                <button className="btn btn-primary" onClick={() => startCamera(facingMode)}>
                  Start camera
                </button>
              </div>
            )}
            {isSearching && <div className="sj-scanning">Identifying on this device…</div>}
          </div>

          <div className="sj-capture-bar">
            {!capturedPreview ? (
              <button className="sj-capture-btn" onClick={handleCapture} disabled={!cameraActive || isSearching || !isOnline || !ready}>
                {!ready
                  ? 'Loading model…'
                  : isSearching
                    ? 'Identifying…'
                    : `Capture & identify${category ? ` · ${CATEGORY_CHIPS.find((c) => c.value === category)?.label}` : ''}`}
              </button>
            ) : (
              <button className="btn btn-secondary sj-wide-btn" onClick={handleReset} disabled={isSearching}>
                <RotateCcw size={16} /> New scan
              </button>
            )}
            <label className={`sj-upload ${isSearching || !isOnline || !ready ? 'disabled' : ''}`}>
              <Upload size={14} /> Pick photo from gallery
              <input type="file" accept="image/jpeg,image/png,image/webp" disabled={isSearching || !isOnline || !ready} onChange={handleFileUpload} hidden />
            </label>
          </div>
        </div>

        {/* Results column */}
        <div>
          {searchError && (
            <div className="sj-alert sj-alert-red">
              <AlertTriangle size={18} />
              <div>
                <strong>Search failed.</strong> {searchError}
                <div className="sj-small sj-muted">Saved in the test log as an error.</div>
              </div>
            </div>
          )}

          {!isSearching && !response && !searchError && (
            <div className="sj-card sj-muted sj-center">
              Pick a category (optional), point the camera at one piece and tap <b>Capture &amp; identify</b>.
            </div>
          )}

          {response && !isSearching && (
            <>
              <div className="sj-latency">
                Total {currentRecord?.client_round_trip_ms ?? '-'} ms · prepare {currentRecord?.telemetry.preprocess_ms ?? '-'} · model{' '}
                {currentRecord?.telemetry.inference_ms ?? '-'} ({loadInfo?.backend === 'webgpu' ? 'GPU' : 'CPU'}) · search{' '}
                {response.telemetry?.total_ms ?? '-'} · 0 neurons
              </div>

              {outcomeBanner && (
                <div className="sj-saved">
                  <Check size={16} /> {outcomeBanner}
                </div>
              )}

              {matches.length === 0 ? (
                <div className="sj-card sj-center">
                  <Package size={32} className="sj-muted" />
                  <div>No matches returned.</div>
                  <button className="btn btn-secondary sj-wide-btn" style={{ marginTop: 10 }} onClick={() => setPickerMode('not_in_top6')}>
                    Mark the correct item…
                  </button>
                </div>
              ) : (
                <>
                  <div className="sj-small sj-muted" style={{ margin: '4px 0 8px' }}>Tap “This one” on the correct item:</div>
                  <div className="sj-match-list">
                    {matches.map((m, idx) => {
                      const full = m.image_key ? api.images.getUrl(m.image_key, m.updated_at) : '';
                      const thumb = m.thumb_key ? api.images.getUrl(m.thumb_key, m.updated_at) : full;
                      const selected = currentRecord?.outcome === 'found' && currentRecord.selection?.id === m.id;
                      return (
                        <div key={m.id} className={`sj-match ${selected ? 'selected' : ''}`}>
                          <div className="sj-rank">#{idx + 1}</div>
                          <button className="sj-thumb" onClick={() => full && setLightboxUrl(full)} aria-label={`View ${m.item_id}`}>
                            {thumb ? <img src={thumb} alt={m.item_id} /> : <Layers size={22} />}
                          </button>
                          <div className="sj-match-info">
                            <div className="sj-match-id">{m.item_id}</div>
                            <div className="sj-small sj-muted">
                              score {m.score.toFixed(3)} · {m.quantity} {m.unit}
                              {m.match_model_version && m.match_model_version !== response.model_version && (
                                <span className="sj-stale"> · old fingerprint ({m.match_model_version})</span>
                              )}
                            </div>
                            {isOwner && m.cost_price !== undefined && (
                              <div className="sj-small sj-muted">Cost ₹{m.cost_price.toFixed(2)}</div>
                            )}
                            <div className="sj-match-actions">
                              <button className={`sj-this-btn ${selected ? 'on' : ''}`} onClick={() => handleMarkMatch(m, idx)}>
                                <Check size={14} /> {selected ? 'Selected (tap to undo)' : 'This one'}
                              </button>
                              {onQuickOperate && (
                                <button className="sj-icon-btn" onClick={() => onQuickOperate('plated_jewelry', m)} title="Stock action">
                                  <ArrowUpDown size={14} />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="sj-btn-col" style={{ marginTop: 10 }}>
                    <button
                      className={`btn ${currentRecord?.outcome === 'not_in_top6' ? 'btn-primary' : 'btn-secondary'} sj-wide-btn`}
                      onClick={() => setPickerMode('not_in_top6')}
                    >
                      <Search size={14} /> Not in top 6, pick the correct item…
                    </button>
                    <button
                      className={`btn ${currentRecord?.outcome === 'false_accept' ? 'btn-primary' : 'btn-secondary'} sj-wide-btn`}
                      onClick={handleToggleFalseAccept}
                    >
                      This is not a catalog item
                    </button>
                  </div>
                </>
              )}

              {currentRecord && (
                <div className="sj-card">
                  <label className="sj-small" htmlFor="sd-reason"><b>Note (optional)</b>, e.g. “scanned from laptop screen”</label>
                  <textarea
                    id="sd-reason"
                    className="sj-textarea"
                    rows={2}
                    value={reasonDraft}
                    onChange={(e) => setReasonDraft(e.target.value)}
                    onBlur={handleSaveReason}
                    placeholder="Anything worth noting?"
                  />
                  {reasonDraft.trim() !== (currentRecord.reason || '') && (
                    <button className="btn btn-secondary sj-small-btn" onClick={handleSaveReason}>Save note</button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Correct-item picker (bottom sheet) */}
      {pickerMode && (
        <div className="sj-sheet-backdrop" onClick={() => setPickerMode(null)}>
          <div className="sj-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sj-row-between">
              <strong>Pick the correct item</strong>
              <button className="sj-icon-btn" onClick={() => setPickerMode(null)} aria-label="Close"><X size={18} /></button>
            </div>
            <input
              className="sj-input"
              autoFocus
              placeholder="Type item ID, e.g. PS 367"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
            />
            <div className="sj-picker-list">
              {pickerResults.map((item) => {
                const thumb = item.thumb_key ? api.images.getUrl(item.thumb_key, item.updated_at) : '';
                return (
                  <button key={item.id} className="sj-picker-item" disabled={pickerBusy} onClick={() => handlePickCorrectItem(item)}>
                    {thumb ? <img src={thumb} alt="" /> : <Layers size={18} />}
                    <span>{item.item_id}</span>
                  </button>
                );
              })}
              {pickerResults.length === 0 && <div className="sj-muted sj-small">No items with photos match.</div>}
            </div>
            <button className="btn btn-secondary sj-wide-btn" disabled={pickerBusy} onClick={() => setOutcome(pickerMode, null)}>
              I don’t know the item, just mark it
            </button>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightboxUrl && (
        <div className="sj-sheet-backdrop" style={{ alignItems: 'center' }} onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="Catalog photo" style={{ maxWidth: '94vw', maxHeight: '88vh', objectFit: 'contain', borderRadius: 8 }} />
        </div>
      )}

      <style>{`
        .sj-root { padding: 12px; max-width: 1100px; margin: 0 auto; box-sizing: border-box; }
        .sj-root * { box-sizing: border-box; }
        .sj-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; }
        .sj-title { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; color: var(--text-primary); min-width: 0; }
        .sj-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--teal-faint); color: var(--teal-deep); border: 1px solid var(--teal-border); white-space: nowrap; }
        .sj-small-btn { font-size: 12px !important; padding: 6px 10px !important; display: inline-flex; align-items: center; gap: 4px; }
        .sj-session { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border-radius: var(--radius-md); background: var(--bg-surface-1); border: 1px solid var(--border-subtle); margin-bottom: 10px; font-size: 13px; color: var(--text-primary); }
        .sj-session-actions { display: flex; gap: 6px; }
        .sj-muted { color: var(--text-secondary); }
        .sj-small { font-size: 12px; }
        .sj-center { text-align: center; }
        .sj-row { display: flex; align-items: center; gap: 8px; }
        .sj-row-between { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
        .sj-alert { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: var(--radius-md); font-size: 13px; margin-bottom: 10px; }
        .sj-alert-red { background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.25); color: #B91C1C; }
        .sj-alert-amber { background: rgba(245,158,11,.10); border: 1px solid rgba(245,158,11,.3); color: #92400E; }
        .sj-card { background: var(--bg-surface-1); border: 1px solid var(--border-medium); border-radius: var(--radius-lg); padding: 12px; margin-bottom: 10px; }
        .sd-progress { height: 8px; border-radius: 999px; background: var(--bg-surface-2); overflow: hidden; margin: 8px 0; }
        .sd-progress div { height: 100%; background: linear-gradient(90deg, var(--teal-deep), var(--teal-light)); transition: width .2s; }
        .sj-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 6px; margin-bottom: 8px; }
        .sj-stat-grid div { background: var(--bg-surface-2); border-radius: var(--radius-sm); padding: 6px 8px; display: flex; flex-direction: column; }
        .sj-stat-grid span { font-size: 11px; color: var(--text-secondary); }
        .sj-stat-grid b { font-size: 16px; color: var(--text-primary); }
        .sj-errors { margin: 6px 0; padding-left: 18px; font-size: 11px; color: #B91C1C; max-height: 120px; overflow: auto; }
        .sj-btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
        .sj-btn-col { display: flex; flex-direction: column; gap: 8px; }
        .sj-chips { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 8px; -webkit-overflow-scrolling: touch; }
        .sj-chip { flex: 0 0 auto; padding: 8px 12px; border-radius: 999px; border: 1px solid var(--border-medium); background: var(--bg-surface-1); color: var(--text-primary); font-size: 13px; cursor: pointer; }
        .sj-chip.active { background: var(--teal-deep); color: #fff; border-color: var(--teal-deep); }
        .sj-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
        @media (min-width: 900px) { .sj-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); align-items: start; } }
        .sj-viewfinder { position: relative; width: 100%; max-width: 520px; margin: 0 auto; aspect-ratio: 1 / 1; background: #0F172A; border-radius: var(--radius-xl); overflow: hidden; }
        .sj-fill { width: 100%; height: 100%; display: block; }
        .sj-reticle { position: absolute; inset: 12%; border: 2px dashed rgba(212,175,55,.7); border-radius: var(--radius-md); box-shadow: 0 0 0 9999px rgba(0,0,0,.35); pointer-events: none; }
        .sj-cam-controls { position: absolute; top: 10px; right: 10px; display: flex; gap: 8px; }
        .sj-round-btn { width: 40px; height: 40px; border-radius: 50%; border: none; background: rgba(0,0,0,.6); color: #fff; display: flex; align-items: center; justify-content: center; }
        .sj-round-btn.on { background: #D4AF37; color: #000; }
        .sj-cam-off { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: rgba(255,255,255,.8); text-align: center; padding: 20px; font-size: 14px; }
        .sj-scanning { position: absolute; left: 0; right: 0; bottom: 0; padding: 10px; text-align: center; background: rgba(0,0,0,.6); color: #fff; font-weight: 600; font-size: 14px; }
        .sj-capture-bar { display: flex; flex-direction: column; gap: 8px; max-width: 520px; margin: 10px auto 0; }
        .sj-capture-btn { width: 100%; min-height: 52px; border: none; border-radius: var(--radius-md); background: linear-gradient(135deg, var(--teal-deep), var(--teal-light)); color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; }
        .sj-capture-btn:disabled { opacity: .6; cursor: not-allowed; }
        .sj-wide-btn { width: 100%; min-height: 44px; display: inline-flex !important; align-items: center; justify-content: center; gap: 6px; }
        .sj-upload { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; font-size: 14px; color: var(--teal-light); background: var(--teal-faint); border: 1px solid var(--teal-border); border-radius: var(--radius-md); cursor: pointer; }
        .sj-upload.disabled { opacity: .6; cursor: not-allowed; }
        .sj-latency { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
        .sj-saved { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: var(--radius-md); background: rgba(16,185,129,.1); border: 1px solid rgba(16,185,129,.3); color: #047857; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
        .sj-match-list { display: flex; flex-direction: column; gap: 8px; }
        .sj-match { position: relative; display: flex; gap: 10px; padding: 10px; border-radius: var(--radius-lg); border: 1px solid var(--border-medium); background: var(--bg-surface-1); }
        .sj-match.selected { border: 2px solid #10B981; background: rgba(16,185,129,.06); }
        .sj-rank { position: absolute; top: -8px; left: 8px; font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: var(--teal-deep); color: #fff; }
        .sj-thumb { flex: 0 0 76px; width: 76px; height: 76px; padding: 0; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border-subtle); background: var(--bg-surface-2); display: flex; align-items: center; justify-content: center; cursor: zoom-in; }
        .sj-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .sj-match-info { flex: 1; min-width: 0; }
        .sj-match-id { font-family: var(--font-mono); font-weight: 700; font-size: 15px; color: var(--teal-deep); }
        .sj-stale { color: #B45309; }
        .sj-match-actions { display: flex; gap: 6px; margin-top: 6px; }
        .sj-this-btn { flex: 1; min-height: 40px; border-radius: var(--radius-md); border: 1px solid #10B981; background: #fff; color: #047857; font-weight: 700; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; }
        .sj-this-btn.on { background: #10B981; color: #fff; }
        .sj-icon-btn { min-width: 40px; min-height: 40px; border-radius: var(--radius-md); border: 1px solid var(--border-medium); background: var(--bg-surface-1); color: var(--text-primary); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
        .sj-textarea, .sj-input { width: 100%; margin: 6px 0; padding: 10px; font-size: 16px; border-radius: var(--radius-md); border: 1px solid var(--border-medium); background: var(--bg-surface-1); color: var(--text-primary); }
        .sj-sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 9999; display: flex; align-items: flex-end; justify-content: center; }
        .sj-sheet { width: 100%; max-width: 560px; max-height: 85vh; display: flex; flex-direction: column; gap: 6px; background: var(--bg-surface-1); border-radius: 16px 16px 0 0; padding: 14px; }
        .sj-picker-list { flex: 1; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; padding: 4px 0 8px; min-height: 120px; }
        .sj-picker-item { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px; border-radius: var(--radius-md); border: 1px solid var(--border-medium); background: var(--bg-surface-2); color: var(--text-primary); font-size: 12px; font-weight: 600; cursor: pointer; }
        .sj-picker-item img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 6px; }
      `}</style>
    </div>
  );
};
