import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
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
  Ban,
} from 'lucide-react';
import { api } from '../api';
import { localDb } from '../lib/localDb';
import type {
  User,
  VisualSearchMatch,
  VisualSearchResponse,
  VisualSearchStatusResponse,
  PlatedJewelryItem,
  ScanCategory,
  JewelryAttributes,
} from '../types';
import { useToast } from '../context/ToastContext';
import {
  loadScanLog,
  saveScanLog,
  clearScanLog,
  cosineSimilarity,
  summarize,
  type ScanTestRecord,
  type ScanOutcome,
  estimateNeurons,
} from '../lib/scanTestLog';
import { generateScanTestReport } from '../utils/scanReportPdf';

interface ScanJewelryViewProps {
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

const MAX_SEND_DIM = 768; // Llama sees enough detail to count stones/bells; ~60–150 KB JPEG
const JPEG_QUALITY = 0.82;

interface PreparedImage {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

type PickerMode = 'not_in_top6' | 'false_reject';

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const ScanJewelryView: React.FC<ScanJewelryViewProps> = ({ user, onQuickOperate }) => {
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
  const [response, setResponse] = useState<VisualSearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [quotaExhaustedMsg, setQuotaExhaustedMsg] = useState<string | null>(null);
  const [showAttributes, setShowAttributes] = useState(false);
  const queryVectorRef = useRef<number[] | null>(null);

  // ── Test log ──
  const [records, setRecords] = useState<ScanTestRecord[]>(() => loadScanLog());
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

  // ── Owner index panel ──
  const [showIndexPanel, setShowIndexPanel] = useState(false);
  const [indexStatus, setIndexStatus] = useState<VisualSearchStatusResponse | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [backfillNote, setBackfillNote] = useState<string | null>(null);
  const [backfillErrors, setBackfillErrors] = useState<string[]>([]);
  const stopBackfillRef = useRef(false);

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
    if (isOnline) startCamera(facingMode);
    return () => stopCamera();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-attach the stream when the <video> element re-mounts (e.g. after "New scan")
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

  // ═══ Image preparation ═══
  /**
   * Camera: crop the centre square (exactly what the viewfinder shows), scale to 768.
   * Gallery: keep the whole photo (bracelets are wide), scale longest side to 768.
   */
  const prepareImage = (
    source: HTMLVideoElement | HTMLImageElement,
    srcW: number,
    srcH: number,
    cropSquare: boolean
  ): PreparedImage => {
    let sx = 0;
    let sy = 0;
    let sw = srcW;
    let sh = srcH;
    if (cropSquare) {
      const side = Math.min(srcW, srcH);
      sx = (srcW - side) / 2;
      sy = (srcH - side) / 2;
      sw = side;
      sh = side;
    }
    const scale = Math.min(1, MAX_SEND_DIM / Math.max(sw, sh));
    const width = Math.round(sw * scale);
    const height = Math.round(sh * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const bytes = Math.round(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);
    return { dataUrl, width, height, bytes };
  };

  // ═══ Test log helpers ═══
  const updateRecords = (updater: (prev: ScanTestRecord[]) => ScanTestRecord[]) => {
    setRecords((prev) => {
      const next = updater(prev);
      if (!saveScanLog(next)) {
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
  const performSearch = async (img: PreparedImage, source: 'camera' | 'gallery') => {
    if (!isOnline) {
      showToast('error', 'Offline', 'Visual search needs an internet connection.');
      return;
    }
    setIsSearching(true);
    setSearchError(null);
    setQuotaExhaustedMsg(null);
    setResponse(null);
    setPickerMode(null);
    setReasonDraft('');
    setShowAttributes(false);
    queryVectorRef.current = null;
    if (navigator.vibrate) navigator.vibrate(40);

    const base: ScanTestRecord = {
      id: newId(),
      n: (records[records.length - 1]?.n ?? 0) + 1,
      ts: new Date().toISOString(),
      source,
      prompt_version: null,
      category_filter: category,
      image: { width: img.width, height: img.height, bytes: img.bytes },
      client_round_trip_ms: null,
      telemetry: {},
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

    const t0 = performance.now();
    try {
      const res = await api.visualSearch.search(img.dataUrl, category);
      const roundTrip = Math.round(performance.now() - t0);
      setResponse(res);
      queryVectorRef.current = res.query_vector || null;
      const t = res.telemetry;
      const record: ScanTestRecord = {
        ...base,
        prompt_version: res.prompt_version || null,
        client_round_trip_ms: roundTrip,
        telemetry: {
          vision_ms: t?.vision_ms,
          embedding_ms: t?.embedding_ms,
          vectorize_ms: t?.vectorize_ms,
          db_ms: t?.db_ms,
          total_pipeline_ms: t?.total_pipeline_ms,
          vision_attempts: t?.vision_attempts,
          prompt_tokens: t?.prompt_tokens ?? null,
          completion_tokens: t?.completion_tokens ?? null,
        },
        rejected: Boolean(res.rejected),
        ai_attributes: res.ai_attributes || null,
        embedding_text: res.embedding_text || null,
        raw_vision_output: res.raw_vision_output || null,
        matches: (res.matches || []).map((m, i) => ({
          rank: i + 1,
          id: m.id,
          item_id: m.item_id,
          score: m.score,
          category: m.match_category ?? null,
        })),
        top1_attributes: res.matches?.[0]?.match_attributes ?? null,
        filter_warning: res.filter_warning || null,
      };
      updateRecords((prev) => [...prev, record]);
      setCurrentRecordId(record.id);
      if (res.filter_warning) showToast('warning', 'Category filter', res.filter_warning);
    } catch (err: any) {
      const roundTrip = Math.round(performance.now() - t0);
      const isQuota = err.status === 429 || err.data?.quota_exhausted;
      const message = isQuota ? 'Daily AI quota exhausted' : err.data?.detail || err.message || 'Visual search failed';
      if (isQuota) {
        setQuotaExhaustedMsg(
          "Today's free AI quota has been reached. It resets at 00:00 UTC (05:30 AM IST)."
        );
      } else {
        setSearchError(message);
      }
      const t = err.data?.telemetry;
      const record: ScanTestRecord = {
        ...base,
        prompt_version: t?.prompt_version || null,
        client_round_trip_ms: roundTrip,
        telemetry: t
          ? {
              vision_ms: t.vision_ms,
              embedding_ms: t.embedding_ms,
              vision_attempts: t.vision_attempts,
              prompt_tokens: t.prompt_tokens ?? null,
              completion_tokens: t.completion_tokens ?? null,
            }
          : {},
        raw_vision_output: err.data?.raw_vision_output || null,
        outcome: 'error',
        error: `${err.status || ''} ${message}`.trim(),
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
    try {
      const img = prepareImage(video, video.videoWidth, video.videoHeight, true);
      setCapturedPreview(img.dataUrl);
      performSearch(img, 'camera');
    } catch (err: any) {
      showToast('error', 'Capture failed', err.message);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('error', 'Invalid file', 'Please select an image (JPEG, PNG, WebP).');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const el = new Image();
      el.onload = () => {
        try {
          const img = prepareImage(el, el.width, el.height, false);
          setCapturedPreview(img.dataUrl);
          performSearch(img, 'gallery');
        } catch (err: any) {
          showToast('error', 'Image processing failed', err.message);
        }
      };
      el.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleReset = () => {
    setCapturedPreview(null);
    setResponse(null);
    setSearchError(null);
    setQuotaExhaustedMsg(null);
    setPickerMode(null);
    setCurrentRecordId(null);
    setReasonDraft('');
    queryVectorRef.current = null;
    if (!cameraActive && isOnline) startCamera(facingMode);
  };

  // ═══ Feedback marking ═══
  const setOutcome = (outcome: ScanOutcome, selection: ScanTestRecord['selection']) => {
    patchCurrent({ outcome, selection });
    setPickerMode(null);
  };

  const handleMarkMatch = (match: VisualSearchMatch, idx: number) => {
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
      attributes: match.match_attributes ?? null,
      embedding_text: match.match_embedding_text ?? null,
    });
  };

  const handleToggleSimpleOutcome = (outcome: 'true_reject' | 'false_accept') => {
    if (!currentRecord) return;
    setOutcome(currentRecord.outcome === outcome ? 'unmarked' : outcome, null);
  };

  // Picker search over the local catalog copy (works offline, no server cost)
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
    let attributes: JewelryAttributes | null = null;
    let embeddingText: string | null = null;
    let score: number | null = null;
    let cat: string | null = null;
    try {
      const d = await api.visualSearch.descriptor(item.id);
      indexed = d.indexed;
      attributes = d.attributes ?? null;
      embeddingText = d.embedding_text ?? null;
      cat = d.category ?? null;
      if (d.values && queryVectorRef.current) score = cosineSimilarity(queryVectorRef.current, d.values);
    } catch {
      showToast('warning', 'Partial info', 'Could not load this item’s stored vector; saved without its score.');
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
      attributes,
      embedding_text: embeddingText,
    });
    if (!indexed) showToast('warning', 'Item not indexed', `${item.item_id} has no vector, so search could never find it.`);
  };

  const handleSaveReason = () => {
    if (currentRecord && reasonDraft !== currentRecord.reason) patchCurrent({ reason: reasonDraft.trim() });
  };

  // ═══ Report ═══
  const handleDownloadReport = () => {
    if (!records.length) return;
    try {
      generateScanTestReport(records);
    } catch (err: any) {
      showToast('error', 'Report failed', err.message || 'Could not build the PDF.');
    }
  };

  const handleClearSession = () => {
    if (!records.length) return;
    if (!window.confirm(`Delete all ${records.length} test scans on this device? Download the report first if you need it.`)) return;
    clearScanLog();
    setRecords([]);
    setCurrentRecordId(null);
  };

  // ═══ Owner: index status + backfill ═══
  const fetchIndexStatus = async () => {
    if (!isOwner) return;
    setIsLoadingStatus(true);
    try {
      setIndexStatus(await api.visualSearch.getStatus());
    } catch {
      /* ignore */
    } finally {
      setIsLoadingStatus(false);
    }
  };

  useEffect(() => {
    if (isOwner && showIndexPanel) fetchIndexStatus();
  }, [isOwner, showIndexPanel]); // eslint-disable-line react-hooks/exhaustive-deps

  const runBackfill = async () => {
    if (!isOwner || isBackfilling) return;
    setIsBackfilling(true);
    stopBackfillRef.current = false;
    setBackfillErrors([]);
    let total = 0;
    try {
      while (!stopBackfillRef.current) {
        const res = await api.visualSearch.backfill();
        total += res.embedded;
        setBackfillNote(`${total} indexed this run · ${res.remaining} remaining`);
        if (res.errors?.length) setBackfillErrors((prev) => [...prev, ...res.errors].slice(-8));
        if (res.quota_exhausted) {
          showToast('warning', 'AI quota reached', res.message || 'Resets at 05:30 AM IST.');
          break;
        }
        if (res.remaining === 0 || res.batch_size === 0) {
          showToast('success', 'Indexing complete', `${total} items indexed.`);
          break;
        }
        // Stop instead of looping forever on items that keep failing (would burn quota)
        if (res.embedded === 0) {
          showToast('warning', 'Indexing stopped', 'A whole batch failed. Check the errors below.');
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch (err: any) {
      showToast('error', 'Indexing failed', err.message || 'Error during batch embedding.');
    } finally {
      setIsBackfilling(false);
      fetchIndexStatus();
    }
  };

  const handleReindexAll = async () => {
    if (!window.confirm('Re-index every catalog image with the current prompt? This uses AI quota for each image.')) return;
    try {
      const res = await api.visualSearch.reindexReset();
      showToast('info', 'Re-index started', `${res.reset} images queued (${res.prompt_version}).`);
      await fetchIndexStatus();
      runBackfill();
    } catch (err: any) {
      showToast('error', 'Reset failed', err.message);
    }
  };

  // ═══ Render helpers ═══
  const matches = response?.matches || [];
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
      case 'false_reject':
        return `Saved: wrongly rejected${r.selection ? ` (correct: ${r.selection.item_id})` : ''}`;
      case 'true_reject':
        return 'Saved: correctly rejected (not catalog jewelry)';
      case 'false_accept':
        return 'Saved: non-catalog object got matches';
      case 'error':
        return `Saved as error: ${r.error}`;
      default:
        return null;
    }
  })();

  const attrChips = (a: JewelryAttributes | null | undefined) => {
    if (!a) return null;
    const entries = Object.entries(a).filter(
      ([k, v]) => k !== 'is_jewelry' && v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)
    );
    return (
      <div className="sj-chips-wrap">
        {entries.map(([k, v]) => (
          <span key={k} className="sj-attr">
            <b>{k.replace(/_/g, ' ')}:</b> {Array.isArray(v) ? v.join(', ') : String(v)}
          </span>
        ))}
      </div>
    );
  };

  // ═══ Render ═══
  return (
    <div className="sj-root">
      {/* Header */}
      <div className="sj-header">
        <div className="sj-title">
          <Camera size={20} />
          <span>Scan Jewelry</span>
          <span className="sj-badge">Test · {response?.prompt_version || 'v2-json'}</span>
        </div>
        {isOwner && (
          <button className="btn btn-secondary sj-small-btn" onClick={() => setShowIndexPanel(!showIndexPanel)}>
            <Sliders size={14} /> Index {showIndexPanel ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>

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
          <WifiOff size={18} /> Visual search needs an internet connection.
        </div>
      )}
      {quotaExhaustedMsg && (
        <div className="sj-alert sj-alert-amber">
          <AlertTriangle size={18} /> {quotaExhaustedMsg}
        </div>
      )}

      {/* Owner index panel */}
      {isOwner && showIndexPanel && (
        <div className="sj-card">
          <div className="sj-row-between">
            <strong>Vector index</strong>
            <button className="btn btn-secondary sj-small-btn" onClick={fetchIndexStatus} disabled={isLoadingStatus}>
              <RefreshCw size={12} className={isLoadingStatus ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
          {indexStatus ? (
            <>
              <div className="sj-stat-grid">
                <div><span>Items</span><b>{indexStatus.total_items}</b></div>
                <div><span>With photo</span><b>{indexStatus.with_images}</b></div>
                <div><span>Indexed</span><b>{indexStatus.indexed}</b></div>
                <div><span>Pending</span><b>{indexStatus.remaining}</b></div>
              </div>
              <div className="sj-muted sj-small">Prompt: {indexStatus.pipeline?.prompt_version || '-'}</div>
              {backfillNote && <div className="sj-small">{backfillNote}</div>}
              {backfillErrors.length > 0 && (
                <ul className="sj-errors">
                  {backfillErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
              <div className="sj-btn-row">
                {isBackfilling ? (
                  <button className="btn btn-secondary" onClick={() => { stopBackfillRef.current = true; }}>
                    Pause
                  </button>
                ) : (
                  <>
                    <button className="btn btn-primary" onClick={runBackfill} disabled={indexStatus.remaining === 0}>
                      Index pending ({indexStatus.remaining})
                    </button>
                    <button className="btn btn-secondary" onClick={handleReindexAll}>
                      Re-index all
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
                {isOnline && (
                  <button className="btn btn-primary" onClick={() => startCamera(facingMode)}>
                    Start camera
                  </button>
                )}
              </div>
            )}
            {isSearching && <div className="sj-scanning">Analyzing…</div>}
          </div>

          <div className="sj-capture-bar">
            {!capturedPreview ? (
              <button className="sj-capture-btn" onClick={handleCapture} disabled={!cameraActive || isSearching || !isOnline}>
                {isSearching
                  ? 'Analyzing…'
                  : `Capture & identify${category ? ` · ${CATEGORY_CHIPS.find((c) => c.value === category)?.label}` : ''}`}
              </button>
            ) : (
              <button className="btn btn-secondary sj-wide-btn" onClick={handleReset} disabled={isSearching}>
                <RotateCcw size={16} /> New scan
              </button>
            )}
            <label className={`sj-upload ${isSearching || !isOnline ? 'disabled' : ''}`}>
              <Upload size={14} /> Pick photo from gallery
              <input type="file" accept="image/jpeg,image/png,image/webp" disabled={isSearching || !isOnline} onChange={handleFileUpload} hidden />
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
                Total {currentRecord?.client_round_trip_ms ?? response.query_time_ms} ms · vision {response.telemetry?.vision_ms ?? '-'} ·
                embed {response.telemetry?.embedding_ms ?? '-'} · search {response.telemetry?.vectorize_ms ?? '-'}
                {(response.telemetry?.vision_attempts ?? 1) > 1 && ' · JSON retry'}
                {currentRecord && estimateNeurons(currentRecord) && ` · ~${estimateNeurons(currentRecord)!.total.toFixed(1)} neurons`}
              </div>

              {outcomeBanner && (
                <div className="sj-saved">
                  <Check size={16} /> {outcomeBanner}
                </div>
              )}

              {/* AI attributes */}
              <button className="sj-attr-toggle" onClick={() => setShowAttributes(!showAttributes)}>
                AI read this photo as {showAttributes ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
              {showAttributes && (
                <div className="sj-card sj-small">
                  {attrChips(response.ai_attributes)}
                  {response.embedding_text && <div className="sj-muted" style={{ marginTop: 8 }}>“{response.embedding_text}”</div>}
                </div>
              )}

              {response.rejected ? (
                <div className="sj-card">
                  <div className="sj-row" style={{ color: '#B45309', fontWeight: 700 }}>
                    <Ban size={18} /> Not recognised as jewelry
                  </div>
                  <p className="sj-small sj-muted">Was the AI right?</p>
                  <div className="sj-btn-col">
                    <button
                      className={`btn ${currentRecord?.outcome === 'true_reject' ? 'btn-primary' : 'btn-secondary'} sj-wide-btn`}
                      onClick={() => handleToggleSimpleOutcome('true_reject')}
                    >
                      Correct, it is not catalog jewelry
                    </button>
                    <button className="btn btn-secondary sj-wide-btn" onClick={() => setPickerMode('false_reject')}>
                      Wrong, it is a catalog piece…
                    </button>
                  </div>
                </div>
              ) : matches.length === 0 ? (
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
                              {m.match_prompt_version && m.match_prompt_version !== response.prompt_version && (
                                <span className="sj-stale"> · old vector ({m.match_prompt_version})</span>
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
                      onClick={() => handleToggleSimpleOutcome('false_accept')}
                    >
                      This is not a catalog item
                    </button>
                  </div>
                </>
              )}

              {/* Optional note */}
              {currentRecord && (
                <div className="sj-card">
                  <label className="sj-small" htmlFor="sj-reason"><b>Note (optional)</b>, e.g. “stone is red, #1 had green”</label>
                  <textarea
                    id="sj-reason"
                    className="sj-textarea"
                    rows={2}
                    value={reasonDraft}
                    onChange={(e) => setReasonDraft(e.target.value)}
                    onBlur={handleSaveReason}
                    placeholder="Why was it wrong?"
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
              <strong>{pickerMode === 'false_reject' ? 'Which catalog item was it?' : 'Pick the correct item'}</strong>
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
            <button
              className="btn btn-secondary sj-wide-btn"
              disabled={pickerBusy}
              onClick={() => setOutcome(pickerMode, null)}
            >
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
        .sj-attr-toggle { background: none; border: none; padding: 4px 0; color: var(--teal-light); font-size: 13px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; margin-bottom: 6px; }
        .sj-chips-wrap { display: flex; flex-wrap: wrap; gap: 4px; }
        .sj-attr { font-size: 11px; padding: 2px 6px; border-radius: 6px; background: var(--bg-surface-2); color: var(--text-primary); }
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
