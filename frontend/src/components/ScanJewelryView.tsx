import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Camera,
  RefreshCw,
  Upload,
  Sparkles,
  Zap,
  ZapOff,
  SwitchCamera,
  AlertTriangle,
  Layers,
  ArrowUpDown,
  ZoomIn,
  X,
  IndianRupee,
  Package,
  WifiOff,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  Sliders,
  RotateCcw,
  Download,
  FileText,
} from 'lucide-react';
import { api } from '../api';
import type { User, VisualSearchMatch, VisualSearchStatusResponse, SearchTelemetry } from '../types';
import { useToast } from '../context/ToastContext';

interface ScanJewelryViewProps {
  user: User;
  onQuickOperate?: (category: 'plated_jewelry', item: any) => void;
}

export const ScanJewelryView: React.FC<ScanJewelryViewProps> = ({ user, onQuickOperate }) => {
  const isOwner = user.role === 'owner';
  const { showToast } = useToast();

  // Connectivity
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Camera & Stream State
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Search State
  const [isSearching, setIsSearching] = useState(false);
  const [capturedPreview, setCapturedPreview] = useState<string | null>(null);
  const [matches, setMatches] = useState<VisualSearchMatch[] | null>(null);
  const [queryTimeMs, setQueryTimeMs] = useState<number | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchTelemetry, setSearchTelemetry] = useState<SearchTelemetry | null>(null);
  const [aiDescription, setAiDescription] = useState<string | null>(null);
  const [quotaExhaustedMsg, setQuotaExhaustedMsg] = useState<string | null>(null);

  // Lightbox Modal
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Owner Backfill Manager State
  const [showBackfillPanel, setShowBackfillPanel] = useState(false);
  const [indexStatus, setIndexStatus] = useState<VisualSearchStatusResponse | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{
    embeddedSoFar: number;
    remaining: number;
    lastBatchStatus: string;
  } | null>(null);
  const stopBackfillRef = useRef(false);

  // Initialize camera stream
  const startCamera = useCallback(async (mode: 'environment' | 'user') => {
    setCameraError(null);
    try {
      // Stop existing tracks first
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }

      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: mode,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(newStream);
      setCameraActive(true);

      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
        videoRef.current.play().catch((err) => {
          console.warn('[ScanJewelry] Video play failed:', err);
        });
      }

      // Check torch / flashlight capability
      const videoTrack = newStream.getVideoTracks()[0];
      if (videoTrack) {
        const capabilities: any = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
        setHasTorch(Boolean(capabilities.torch));
      }
    } catch (err: any) {
      console.error('[ScanJewelry] Camera access error:', err);
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
  }, [stream]);

  // Stop camera stream
  const stopCamera = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
    }
    setCameraActive(false);
    setTorchOn(false);
  }, [stream]);

  // Start camera on mount if online, cleanup on unmount
  useEffect(() => {
    if (isOnline) {
      startCamera(facingMode);
    }
    return () => {
      stopCamera();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Toggle front/back camera
  const handleToggleFacingMode = () => {
    const nextMode = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(nextMode);
    startCamera(nextMode);
  };

  // Toggle torch / flashlight
  const handleToggleTorch = async () => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (track && hasTorch) {
      const nextTorch = !torchOn;
      try {
        await (track as any).applyConstraints({
          advanced: [{ torch: nextTorch }],
        });
        setTorchOn(nextTorch);
      } catch (err) {
        console.warn('[ScanJewelry] Torch toggle failed:', err);
      }
    }
  };

  // ── Preprocessing Engine: Crop center square, fill white, scale to 224x224 JPEG ──
  const preprocessImage = (
    source: HTMLVideoElement | HTMLImageElement,
    sourceWidth: number,
    sourceHeight: number
  ): string => {
    const canvas = canvasRef.current || document.createElement('canvas');
    canvas.width = 224;
    canvas.height = 224;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context');

    // 1. Fill solid white background (prevents transparent PNG artifacts)
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 224, 224);

    // 2. Center-crop square from source
    const minDim = Math.min(sourceWidth, sourceHeight);
    const sx = (sourceWidth - minDim) / 2;
    const sy = (sourceHeight - minDim) / 2;

    // 3. Draw cropped source scaled down to 224x224
    ctx.drawImage(source, sx, sy, minDim, minDim, 0, 0, 224, 224);

    // 4. Export as clean JPEG at quality 0.85 (~15-25 KB)
    return canvas.toDataURL('image/jpeg', 0.85);
  };

  // ── Execute Visual Search via Backend ──
  const performSearch = async (base64Data: string) => {
    if (!isOnline) {
      showToast('error', 'Offline', 'Visual search requires an internet connection to run Cloudflare AI.');
      return;
    }

    setIsSearching(true);
    setSearchError(null);
    setQuotaExhaustedMsg(null);
    setMatches(null);
    setSearchTelemetry(null);
    setAiDescription(null);

    // Mobile haptic vibration feedback
    if (navigator.vibrate) {
      navigator.vibrate([40, 60, 40]);
    }

    try {
      const res = await api.visualSearch.search(base64Data);
      setQueryTimeMs(res.query_time_ms);
      setMatches(res.matches || []);
      if (res.telemetry) setSearchTelemetry(res.telemetry);
      if (res.ai_description) setAiDescription(res.ai_description);

      if (res.matches && res.matches.length > 0) {
        showToast('success', 'Match Found', `Found ${res.matches.length} matching plated jewelry designs.`);
      } else {
        showToast('info', 'No Matches', 'No matching jewelry found above the similarity threshold.');
      }
    } catch (err: any) {
      console.error('[ScanJewelry] Search error:', err);
      const isQuota =
        err.status === 429 ||
        err.message?.includes('quota') ||
        err.data?.quota_exhausted;

      if (isQuota) {
        setQuotaExhaustedMsg(
          "Today's free AI quota has been reached. Quota resets at 00:00 UTC (05:30 AM IST). You can resume scanning tomorrow."
        );
      } else {
        setSearchError(err.message || 'Visual search failed. Please try again.');
      }
    } finally {
      setIsSearching(false);
    }
  };

  // ── Download Test Results as JSON ──
  const handleDownloadTestResults = () => {
    const testResults = {
      timestamp: new Date().toISOString(),
      device: {
        userAgent: navigator.userAgent,
        screen: `${window.screen.width}x${window.screen.height}`,
        devicePixelRatio: window.devicePixelRatio,
        online: navigator.onLine,
        platform: navigator.platform,
      },
      pipeline: {
        vision_model: searchTelemetry?.vision_model || '@cf/meta/llama-3.2-11b-vision-instruct',
        embedding_model: searchTelemetry?.embedding_model || '@cf/baai/bge-small-en-v1.5',
        vector_dimensions: searchTelemetry?.vector_dimensions || 384,
      },
      performance: {
        vision_inference_ms: searchTelemetry?.vision_ms,
        embedding_inference_ms: searchTelemetry?.embedding_ms,
        vectorize_query_ms: searchTelemetry?.vectorize_ms,
        db_lookup_ms: searchTelemetry?.db_ms,
        total_pipeline_ms: searchTelemetry?.total_pipeline_ms,
        total_query_time_ms: queryTimeMs,
      },
      input: {
        image_bytes: searchTelemetry?.image_bytes,
        description_length_chars: searchTelemetry?.description_length,
      },
      ai_generated_description: aiDescription,
      search_quality: {
        score_threshold: searchTelemetry?.score_threshold || 0.15,
        total_vectors_returned: searchTelemetry?.matches_found,
        matches_above_threshold: searchTelemetry?.matches_above_threshold,
        matches_with_db_data: searchTelemetry?.matches_with_db_data,
      },
      matches: (matches || []).map((m) => ({
        item_id: m.item_id,
        similarity_score: m.score,
        quantity: m.quantity,
        unit: m.unit,
        is_low_stock: m.is_low_stock,
        cost_price: m.cost_price,
      })),
    };

    const blob = new Blob([JSON.stringify(testResults, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `visual-search-test-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('success', 'Downloaded', 'Test results JSON saved to your device.');
  };

  // Snap from live camera
  const handleCapture = () => {
    if (!videoRef.current || !cameraActive) return;
    const video = videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      showToast('warning', 'Camera Not Ready', 'Please wait for the camera feed to stabilize.');
      return;
    }

    try {
      const preprocessed = preprocessImage(video, video.videoWidth, video.videoHeight);
      setCapturedPreview(preprocessed);
      performSearch(preprocessed);
    } catch (err: any) {
      showToast('error', 'Capture Failed', err.message);
    }
  };

  // Pick / Upload from file picker
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showToast('error', 'Invalid File', 'Please select a valid image file (JPEG, PNG, WebP).');
      return;
    }

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const img = new Image();
      img.onload = () => {
        try {
          const preprocessed = preprocessImage(img, img.width, img.height);
          setCapturedPreview(preprocessed);
          performSearch(preprocessed);
        } catch (err: any) {
          showToast('error', 'Image Processing Failed', err.message);
        }
      };
      img.src = loadEvent.target?.result as string;
    };
    reader.readAsDataURL(file);

    // Reset input so re-selecting the same file triggers change
    e.target.value = '';
  };

  // Reset scan to start new capture
  const handleReset = () => {
    setCapturedPreview(null);
    setMatches(null);
    setSearchError(null);
    setQuotaExhaustedMsg(null);
    setQueryTimeMs(null);
    setSearchTelemetry(null);
    setAiDescription(null);
    if (!cameraActive && isOnline) {
      startCamera(facingMode);
    }
  };

  // ── Owner Vector Index Status & Progressive Backfill ──
  const fetchIndexStatus = async () => {
    if (!isOwner) return;
    setIsLoadingStatus(true);
    try {
      const res = await api.visualSearch.getStatus();
      setIndexStatus(res);
    } catch (err: any) {
      console.warn('[ScanJewelry] Fetch status error:', err);
    } finally {
      setIsLoadingStatus(false);
    }
  };

  useEffect(() => {
    if (isOwner && showBackfillPanel) {
      fetchIndexStatus();
    }
  }, [isOwner, showBackfillPanel]);

  const handleStartBackfill = async () => {
    if (!isOwner || isBackfilling) return;
    setIsBackfilling(true);
    stopBackfillRef.current = false;
    let totalEmbedded = 0;

    showToast('info', 'Backfill Started', 'Generating embeddings in batches of 10 items...');

    try {
      while (!stopBackfillRef.current) {
        const res = await api.visualSearch.backfill();

        totalEmbedded += res.embedded;
        setBackfillProgress({
          embeddedSoFar: totalEmbedded,
          remaining: res.remaining,
          lastBatchStatus: `Processed batch of ${res.batch_size}: ${res.embedded} embedded, ${res.failed} failed.`,
        });

        // If quota exhausted, halt cleanly
        if (res.quota_exhausted) {
          showToast(
            'warning',
            'AI Quota Reached',
            res.message || "Today's AI quota exhausted. Quota resets at 00:00 UTC (05:30 AM IST)."
          );
          break;
        }

        // If no more items to embed, we're done!
        if (res.remaining === 0 || res.batch_size === 0) {
          showToast('success', 'Backfill Complete', `All items are now embedded! (${totalEmbedded} total embedded)`);
          break;
        }

        // Slight pause between batches to yield execution
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch (err: any) {
      console.error('[ScanJewelry] Backfill loop error:', err);
      showToast('error', 'Backfill Failed', err.message || 'An error occurred during batch embedding.');
    } finally {
      setIsBackfilling(false);
      fetchIndexStatus();
    }
  };

  const handleStopBackfill = () => {
    stopBackfillRef.current = true;
    setIsBackfilling(false);
    showToast('info', 'Backfill Paused', 'Batch backfill paused.');
  };

  // Helper for match confidence badge
  const renderConfidenceBadge = (score: number) => {
    const percent = Math.round(score * 100);
    if (score >= 0.35) {
      return (
        <span
          style={{
            background: 'rgba(16, 185, 129, 0.12)',
            color: '#10B981',
            border: '1px solid rgba(16, 185, 129, 0.25)',
            padding: '3px 8px',
            borderRadius: '9999px',
            fontSize: 11,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Sparkles size={12} /> High Match ({percent}%)
        </span>
      );
    }
    if (score >= 0.25) {
      return (
        <span
          style={{
            background: 'rgba(245, 158, 11, 0.12)',
            color: '#F59E0B',
            border: '1px solid rgba(245, 158, 11, 0.25)',
            padding: '3px 8px',
            borderRadius: '9999px',
            fontSize: 11,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          🟡 Good Match ({percent}%)
        </span>
      );
    }
    return (
      <span
        style={{
          background: 'rgba(58, 107, 130, 0.12)',
          color: 'var(--teal-light)',
          border: '1px solid rgba(58, 107, 130, 0.25)',
          padding: '3px 8px',
          borderRadius: '9999px',
          fontSize: 11,
          fontWeight: 600,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        🔵 Similar Design ({percent}%)
      </span>
    );
  };

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100, margin: '0 auto' }}>
      {/* Hidden processing canvas */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Header Title & Subtitle */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 20,
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 'var(--radius-md)',
                background: 'linear-gradient(135deg, var(--teal-deep), var(--teal-light))',
                color: '#FFFFFF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <Camera size={20} />
            </div>
            <div>
              <h1
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                  margin: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                Scan Jewelry
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 9999,
                    background: 'var(--teal-faint)',
                    color: 'var(--teal-deep)',
                    border: '1px solid var(--teal-border)',
                  }}
                >
                  AI Visual Search
                </span>
              </h1>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                Point camera at any plated jewelry to instantly retrieve its Item ID, stock count, and details.
              </p>
            </div>
          </div>
        </div>

        {/* Action Controls in Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isOwner && (
            <button
              onClick={() => setShowBackfillPanel(!showBackfillPanel)}
              className="btn btn-secondary"
              style={{
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 12px',
              }}
            >
              <Sliders size={14} />
              <span>AI Index Status</span>
              {showBackfillPanel ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}

          {capturedPreview && (
            <button
              onClick={handleReset}
              className="btn btn-secondary"
              style={{
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 12px',
              }}
            >
              <RotateCcw size={14} />
              <span>New Scan</span>
            </button>
          )}
        </div>
      </div>

      {/* Offline Warning Banner */}
      {!isOnline && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 16px',
            marginBottom: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: '#B91C1C',
          }}
        >
          <WifiOff size={20} style={{ flexShrink: 0 }} />
          <div style={{ fontSize: 13 }}>
            <strong>Visual Search requires an internet connection:</strong> Cloudflare Workers AI GPU neural network
            runs remotely. Camera scanner is disabled until you reconnect.
          </div>
        </div>
      )}

      {/* Quota Exhaustion Alert */}
      {quotaExhaustedMsg && (
        <div
          style={{
            background: 'rgba(245, 158, 11, 0.10)',
            border: '1px solid rgba(245, 158, 11, 0.30)',
            borderRadius: 'var(--radius-md)',
            padding: '14px 18px',
            marginBottom: 20,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            color: '#92400E',
          }}
        >
          <AlertTriangle size={22} style={{ flexShrink: 0, marginTop: 2, color: '#D97706' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
              Daily Free AI Quota Reached
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              {quotaExhaustedMsg}
            </div>
          </div>
        </div>
      )}

      {/* Owner Backfill Manager Panel (Collapsible) */}
      {isOwner && showBackfillPanel && (
        <div
          style={{
            background: 'var(--bg-surface-1)',
            border: '1px solid var(--border-medium)',
            borderRadius: 'var(--radius-lg)',
            padding: '18px 20px',
            marginBottom: 24,
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShieldCheck size={18} color="var(--accent)" />
              <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Vector Search Index Health (Owner Control)
              </h2>
            </div>
            <button
              onClick={fetchIndexStatus}
              disabled={isLoadingStatus}
              className="btn btn-secondary"
              style={{ fontSize: 11, padding: '4px 8px' }}
            >
              <RefreshCw size={12} className={isLoadingStatus ? 'animate-spin' : ''} />
              <span>Refresh Stats</span>
            </button>
          </div>

          {indexStatus ? (
            <div>
              {/* Stat Grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <div
                  style={{
                    background: 'var(--bg-surface-2)',
                    padding: '10px 14px',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Total Plated Items</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {indexStatus.total_items}
                  </div>
                </div>
                <div
                  style={{
                    background: 'var(--bg-surface-2)',
                    padding: '10px 14px',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Items With Photos</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {indexStatus.with_images}
                  </div>
                </div>
                <div
                  style={{
                    background: 'var(--bg-surface-2)',
                    padding: '10px 14px',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Indexed in Vectorize</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--emerald-text)' }}>
                    {indexStatus.indexed}
                  </div>
                </div>
                <div
                  style={{
                    background: 'var(--bg-surface-2)',
                    padding: '10px 14px',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>AI Search Coverage</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>
                    {indexStatus.coverage_percent}%
                  </div>
                </div>
              </div>

              {/* Progress bar */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Coverage Progress</span>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {indexStatus.indexed} / {indexStatus.with_images} photo items indexed
                  </span>
                </div>
                <div
                  style={{
                    height: 8,
                    borderRadius: 9999,
                    background: 'var(--bg-surface-3)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${indexStatus.coverage_percent}%`,
                      background: 'linear-gradient(90deg, var(--teal-mid), var(--accent))',
                      transition: 'width 0.4s ease',
                    }}
                  />
                </div>
              </div>

              {/* Backfill Progress Note */}
              {backfillProgress && (
                <div
                  style={{
                    background: 'var(--teal-faint)',
                    border: '1px solid var(--teal-border)',
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12,
                    marginBottom: 14,
                    color: 'var(--teal-deep)',
                  }}
                >
                  <strong>Progressive Batch Status:</strong> {backfillProgress.lastBatchStatus} (
                  {backfillProgress.remaining} items remaining in queue)
                </div>
              )}

              {/* Backfill controls */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {!isBackfilling ? (
                  <button
                    onClick={handleStartBackfill}
                    disabled={indexStatus.remaining === 0}
                    className="btn btn-primary"
                    style={{
                      fontSize: 13,
                      padding: '8px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <Sparkles size={16} />
                    <span>
                      {indexStatus.remaining === 0
                        ? 'All Images Indexed (100%)'
                        : `Start Progressive Backfill (${indexStatus.remaining} items)`}
                    </span>
                  </button>
                ) : (
                  <button
                    onClick={handleStopBackfill}
                    className="btn btn-secondary"
                    style={{
                      fontSize: 13,
                      padding: '8px 16px',
                      color: 'var(--rose-text)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <RotateCcw size={16} />
                    <span>Pause Backfill</span>
                  </button>
                )}
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Processed safely in chunks of 10 items to prevent Cloudflare CPU timeouts.
                </span>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading index stats...</div>
          )}
        </div>
      )}

      {/* ── Viewfinder / Scanner Area ── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: capturedPreview || matches !== null ? '1fr 1.2fr' : '1fr',
          gap: 24,
          alignItems: 'start',
        }}
      >
        {/* Left Column: Camera Viewfinder or Preprocessed Preview */}
        <div>
          <div
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '1 / 1',
              maxWidth: 480,
              margin: '0 auto',
              background: '#0F172A',
              borderRadius: 'var(--radius-xl)',
              overflow: 'hidden',
              boxShadow: 'var(--shadow-md)',
              border: '2px solid var(--border-medium)',
            }}
          >
            {/* Captured Preview Mode */}
            {capturedPreview ? (
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <img
                  src={capturedPreview}
                  alt="Captured scan preview"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    top: 12,
                    left: 12,
                    background: 'rgba(0, 0, 0, 0.65)',
                    backdropFilter: 'blur(4px)',
                    color: '#FFFFFF',
                    padding: '4px 10px',
                    borderRadius: 9999,
                    fontSize: 11,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Sparkles size={12} color="#D4AF37" />
                  Preprocessed (224×224)
                </div>
              </div>
            ) : cameraActive ? (
              /* Live Camera Stream with Golden Reticle Overlay */
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <video
                  ref={videoRef}
                  playsInline
                  autoPlay
                  muted
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />

                {/* Golden Precision Reticle */}
                <div
                  style={{
                    position: 'absolute',
                    inset: '16%',
                    boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
                    borderRadius: 'var(--radius-md)',
                    pointerEvents: 'none',
                    border: '1.5px dashed rgba(212, 175, 55, 0.4)',
                  }}
                >
                  {/* Top-Left Corner */}
                  <div
                    style={{
                      position: 'absolute',
                      top: -2,
                      left: -2,
                      width: 24,
                      height: 24,
                      borderTop: '4px solid #D4AF37',
                      borderLeft: '4px solid #D4AF37',
                      borderTopLeftRadius: 'var(--radius-sm)',
                    }}
                  />
                  {/* Top-Right Corner */}
                  <div
                    style={{
                      position: 'absolute',
                      top: -2,
                      right: -2,
                      width: 24,
                      height: 24,
                      borderTop: '4px solid #D4AF37',
                      borderRight: '4px solid #D4AF37',
                      borderTopRightRadius: 'var(--radius-sm)',
                    }}
                  />
                  {/* Bottom-Left Corner */}
                  <div
                    style={{
                      position: 'absolute',
                      bottom: -2,
                      left: -2,
                      width: 24,
                      height: 24,
                      borderBottom: '4px solid #D4AF37',
                      borderLeft: '4px solid #D4AF37',
                      borderBottomLeftRadius: 'var(--radius-sm)',
                    }}
                  />
                  {/* Bottom-Right Corner */}
                  <div
                    style={{
                      position: 'absolute',
                      bottom: -2,
                      right: -2,
                      width: 24,
                      height: 24,
                      borderBottom: '4px solid #D4AF37',
                      borderRight: '4px solid #D4AF37',
                      borderBottomRightRadius: 'var(--radius-sm)',
                    }}
                  />

                  {/* Subtle Center Crosshairs */}
                  <div
                    style={{
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: 14,
                      height: 14,
                      pointerEvents: 'none',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        top: 6,
                        left: 0,
                        right: 0,
                        height: 2,
                        background: 'rgba(212, 175, 55, 0.5)',
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        left: 6,
                        top: 0,
                        bottom: 0,
                        width: 2,
                        background: 'rgba(212, 175, 55, 0.5)',
                      }}
                    />
                  </div>
                </div>

                {/* Laser Scanline Animation when Searching */}
                {isSearching && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: '16%',
                      overflow: 'hidden',
                      pointerEvents: 'none',
                    }}
                  >
                    <div
                      style={{
                        width: '100%',
                        height: 3,
                        background: 'linear-gradient(90deg, transparent, #D4AF37, #FFFFFF, #D4AF37, transparent)',
                        boxShadow: '0 0 12px 2px #D4AF37',
                        animation: 'scanline 1.8s ease-in-out infinite alternate',
                      }}
                    />
                  </div>
                )}

                {/* Guidance Text Overlay */}
                <div
                  style={{
                    position: 'absolute',
                    bottom: 14,
                    left: 0,
                    right: 0,
                    textAlign: 'center',
                    color: 'rgba(255, 255, 255, 0.85)',
                    fontSize: 12,
                    fontWeight: 500,
                    textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                    pointerEvents: 'none',
                  }}
                >
                  Align jewelry inside the box for highest accuracy
                </div>

                {/* Camera Control Badges on Top */}
                <div
                  style={{
                    position: 'absolute',
                    top: 12,
                    left: 12,
                    right: 12,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div
                    style={{
                      background: 'rgba(0, 0, 0, 0.6)',
                      backdropFilter: 'blur(4px)',
                      color: '#FFFFFF',
                      padding: '4px 10px',
                      borderRadius: 9999,
                      fontSize: 11,
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: '#10B981',
                        boxShadow: '0 0 6px #10B981',
                      }}
                    />
                    Live Camera
                  </div>

                  <div style={{ display: 'flex', gap: 6 }}>
                    {hasTorch && (
                      <button
                        onClick={handleToggleTorch}
                        style={{
                          background: torchOn ? '#D4AF37' : 'rgba(0, 0, 0, 0.6)',
                          color: torchOn ? '#000000' : '#FFFFFF',
                          border: 'none',
                          borderRadius: '50%',
                          width: 32,
                          height: 32,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                        }}
                        title={torchOn ? 'Turn Flashlight Off' : 'Turn Flashlight On'}
                      >
                        {torchOn ? <Zap size={16} /> : <ZapOff size={16} />}
                      </button>
                    )}

                    <button
                      onClick={handleToggleFacingMode}
                      style={{
                        background: 'rgba(0, 0, 0, 0.6)',
                        color: '#FFFFFF',
                        border: 'none',
                        borderRadius: '50%',
                        width: 32,
                        height: 32,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                      }}
                      title="Switch Front / Rear Camera"
                    >
                      <SwitchCamera size={16} />
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* Camera Inactive / Permission Needed / Offline View */
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 24,
                  textAlign: 'center',
                  color: 'rgba(255, 255, 255, 0.7)',
                }}
              >
                <Camera size={48} style={{ marginBottom: 12, opacity: 0.5 }} />
                <div style={{ fontSize: 14, fontWeight: 600, color: '#FFFFFF', marginBottom: 6 }}>
                  {cameraError || 'Camera is currently stopped'}
                </div>
                {isOnline && (
                  <button
                    onClick={() => startCamera(facingMode)}
                    className="btn btn-primary"
                    style={{ marginTop: 12, fontSize: 13 }}
                  >
                    Start Camera
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Viewfinder Controls & Capture Bar */}
          <div
            style={{
              marginTop: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              maxWidth: 480,
              margin: '16px auto 0',
            }}
          >
            {/* Primary Action Button */}
            {!capturedPreview ? (
              <button
                onClick={handleCapture}
                disabled={!cameraActive || isSearching || !isOnline}
                style={{
                  width: '100%',
                  padding: '14px 24px',
                  borderRadius: 'var(--radius-md)',
                  background: 'linear-gradient(135deg, var(--teal-deep), var(--teal-light))',
                  color: '#FFFFFF',
                  border: 'none',
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: cameraActive && !isSearching && isOnline ? 'pointer' : 'not-allowed',
                  opacity: cameraActive && !isSearching && isOnline ? 1 : 0.6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  boxShadow: 'var(--shadow-sm)',
                  transition: 'all 0.2s ease',
                }}
              >
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    border: '2px solid #FFFFFF',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: '#FFFFFF',
                    }}
                  />
                </div>
                <span>{isSearching ? 'Analyzing Jewelry Facets...' : 'Capture & Identify'}</span>
              </button>
            ) : (
              <button
                onClick={handleReset}
                className="btn btn-secondary"
                style={{
                  width: '100%',
                  padding: '12px 20px',
                  fontSize: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <RotateCcw size={16} />
                <span>Retake / Scan Another Piece</span>
              </button>
            )}

            {/* Gallery File Upload Option */}
            <div style={{ textAlign: 'center' }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  fontWeight: 500,
                  color: 'var(--teal-light)',
                  cursor: isSearching || !isOnline ? 'not-allowed' : 'pointer',
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--teal-faint)',
                  border: '1px solid var(--teal-border)',
                }}
              >
                <Upload size={14} />
                <span>Or select photo from gallery / disk</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={isSearching || !isOnline}
                  onChange={handleFileUpload}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
          </div>
        </div>

        {/* Right Column: Search Results */}
        <div>
          {isSearching && (
            <div
              style={{
                background: 'var(--bg-surface-1)',
                border: '1px solid var(--border-medium)',
                borderRadius: 'var(--radius-lg)',
                padding: '40px 24px',
                textAlign: 'center',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: '50%',
                  background: 'var(--teal-faint)',
                  margin: '0 auto 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--teal-deep)',
                }}
              >
                <RefreshCw size={24} className="animate-spin" />
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px', color: 'var(--text-primary)' }}>
                Comparing with Vector Catalog...
              </h3>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                Running OpenAI CLIP on Cloudflare Workers AI GPU and querying Vectorize index.
              </p>
            </div>
          )}

          {searchError && (
            <div
              style={{
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                borderRadius: 'var(--radius-md)',
                padding: '16px 20px',
                color: '#B91C1C',
                marginBottom: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <AlertTriangle size={18} />
                <span style={{ fontSize: 14, fontWeight: 700 }}>Search Failed</span>
              </div>
              <div style={{ fontSize: 13 }}>{searchError}</div>
              <button
                onClick={handleReset}
                className="btn btn-secondary"
                style={{ marginTop: 12, fontSize: 12, padding: '5px 12px' }}
              >
                Try Again
              </button>
            </div>
          )}

          {/* Results List */}
          {!isSearching && matches !== null && (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 14,
                }}
              >
                <div>
                  <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                    {matches.length > 0 ? `Top Matches (${matches.length})` : 'No Close Match Found'}
                  </h2>
                  {queryTimeMs !== null && searchTelemetry && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, display: 'block', marginTop: 2 }}>
                      Vision: {searchTelemetry.vision_ms}ms · Embed: {searchTelemetry.embedding_ms}ms · Search: {searchTelemetry.vectorize_ms || 0}ms · Total: {queryTimeMs}ms
                    </span>
                  )}
                  {queryTimeMs !== null && !searchTelemetry && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Completed in {queryTimeMs}ms
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  {searchTelemetry && (
                    <button
                      onClick={handleDownloadTestResults}
                      className="btn btn-secondary"
                      style={{ fontSize: 11, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}
                      title="Download test results JSON"
                    >
                      <Download size={12} />
                      Test JSON
                    </button>
                  )}
                  {matches.length > 0 && (
                    <button
                      onClick={handleReset}
                      className="btn btn-secondary"
                      style={{ fontSize: 11, padding: '4px 10px' }}
                    >
                      Clear Results
                    </button>
                  )}
                </div>
              </div>

              {/* AI Description Display */}
              {aiDescription && (
                <div
                  style={{
                    background: 'linear-gradient(135deg, rgba(212,175,55,0.08), rgba(30,30,30,0.04))',
                    border: '1px solid rgba(212,175,55,0.25)',
                    borderRadius: 'var(--radius-md)',
                    padding: '10px 14px',
                    marginBottom: 14,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <FileText size={13} style={{ color: '#D4AF37' }} />
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#D4AF37', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      AI Vision Description
                    </span>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5, fontStyle: 'italic' }}>
                    {aiDescription}
                  </p>
                </div>
              )}

              {matches.length === 0 ? (
                <div
                  style={{
                    background: 'var(--bg-surface-1)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '36px 24px',
                    textAlign: 'center',
                  }}
                >
                  <Package size={40} style={{ color: 'var(--text-muted)', marginBottom: 12 }} />
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                    No matching plated jewelry found
                  </div>
                  <p
                    style={{
                      fontSize: 13,
                      color: 'var(--text-secondary)',
                      maxWidth: 420,
                      margin: '0 auto 16px',
                      lineHeight: 1.5,
                    }}
                  >
                    The captured item's visual score did not meet the similarity threshold (15%). Try angling the
                    camera closer, using good lighting, or check that an image has been uploaded for this item.
                  </p>
                  <button onClick={handleReset} className="btn btn-primary" style={{ fontSize: 13 }}>
                    Scan Again
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {matches.map((item, idx) => {
                    const imageUrl = item.image_key ? api.images.getUrl(item.image_key, item.updated_at) : '';
                    const thumbUrl = item.thumb_key ? api.images.getUrl(item.thumb_key, item.updated_at) : imageUrl;

                    return (
                      <div
                        key={item.id}
                        style={{
                          background: 'var(--bg-surface-1)',
                          border: idx === 0 && item.score >= 0.35 ? '2px solid #D4AF37' : '1px solid var(--border-medium)',
                          borderRadius: 'var(--radius-lg)',
                          padding: '14px 16px',
                          display: 'flex',
                          gap: 16,
                          boxShadow: 'var(--shadow-card)',
                          position: 'relative',
                        }}
                      >
                        {/* Rank Badge */}
                        <div
                          style={{
                            position: 'absolute',
                            top: -8,
                            left: 12,
                            background: idx === 0 ? '#D4AF37' : 'var(--teal-deep)',
                            color: idx === 0 ? '#000000' : '#FFFFFF',
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '1px 8px',
                            borderRadius: 9999,
                            boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
                          }}
                        >
                          #{idx + 1} Best Match
                        </div>

                        {/* Thumbnail with Zoom Lightbox Click */}
                        <div
                          style={{
                            position: 'relative',
                            width: 84,
                            height: 84,
                            minWidth: 84,
                            borderRadius: 'var(--radius-md)',
                            overflow: 'hidden',
                            background: 'var(--bg-surface-2)',
                            border: '1px solid var(--border-subtle)',
                            cursor: imageUrl ? 'pointer' : 'default',
                          }}
                          onClick={() => imageUrl && setLightboxUrl(imageUrl)}
                          title="Click to view full photo"
                        >
                          {thumbUrl ? (
                            <img
                              src={thumbUrl}
                              alt={item.item_id}
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                          ) : (
                            <div
                              style={{
                                width: '100%',
                                height: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'var(--text-muted)',
                              }}
                            >
                              <Layers size={24} />
                            </div>
                          )}
                          {imageUrl && (
                            <div
                              style={{
                                position: 'absolute',
                                bottom: 4,
                                right: 4,
                                background: 'rgba(0,0,0,0.6)',
                                color: '#FFFFFF',
                                borderRadius: '50%',
                                width: 20,
                                height: 20,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <ZoomIn size={12} />
                            </div>
                          )}
                        </div>

                        {/* Match Details */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'flex-start',
                              gap: 8,
                              marginBottom: 6,
                            }}
                          >
                            <div>
                              <div
                                style={{
                                  fontSize: 16,
                                  fontWeight: 700,
                                  color: 'var(--teal-deep)',
                                  fontFamily: 'var(--font-mono)',
                                }}
                              >
                                {item.item_id}
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                                Plated Jewelry
                              </div>
                            </div>
                            {renderConfidenceBadge(item.score)}
                          </div>

                          {/* Stock and Price details */}
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 16,
                              marginTop: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            {/* Stock Quantity */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <Package size={14} color="var(--text-secondary)" />
                              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                                {item.quantity} {item.unit}
                              </span>
                              {item.is_low_stock && (
                                <span
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 700,
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    background: 'var(--rose-bg)',
                                    color: 'var(--rose-text)',
                                    border: '1px solid var(--rose-border)',
                                  }}
                                >
                                  Low Stock (&lt; {item.low_stock_threshold})
                                </span>
                              )}
                            </div>

                            {/* Cost Price: Strictly Owner Only */}
                            {isOwner && item.cost_price !== undefined && (
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  background: 'var(--amber-bg)',
                                  padding: '2px 8px',
                                  borderRadius: 'var(--radius-sm)',
                                  border: '1px solid var(--amber-border)',
                                }}
                                title="Confidential Cost Price (Owner Only)"
                              >
                                <IndianRupee size={12} color="var(--amber-text)" />
                                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--amber-text)' }}>
                                  ₹{item.cost_price.toFixed(2)}
                                </span>
                              </div>
                            )}
                          </div>

                          {/* 1-Click Take Stock Action Button */}
                          <div style={{ marginTop: 12 }}>
                            <button
                              onClick={() => onQuickOperate?.('plated_jewelry', item)}
                              className="btn btn-secondary"
                              style={{
                                fontSize: 12,
                                padding: '6px 12px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                fontWeight: 600,
                                color: 'var(--teal-deep)',
                                borderColor: 'var(--teal-border)',
                              }}
                            >
                              <ArrowUpDown size={13} />
                              <span>Take Stock Action (Add / Subtract)</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Empty initial state message if no scan has been initiated yet */}
          {!isSearching && matches === null && (
            <div
              style={{
                background: 'var(--bg-surface-1)',
                border: '1px dashed var(--border-medium)',
                borderRadius: 'var(--radius-lg)',
                padding: '40px 24px',
                textAlign: 'center',
                color: 'var(--text-secondary)',
              }}
            >
              <Sparkles size={36} style={{ color: '#D4AF37', marginBottom: 12 }} />
              <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                AI Visual Recognition Ready
              </h3>
              <p style={{ fontSize: 13, maxWidth: 360, margin: '0 auto', lineHeight: 1.5 }}>
                Position a piece of plated jewelry inside the camera frame and tap{' '}
                <strong>Capture & Identify</strong> to locate matching pieces in your inventory.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── High-Resolution Lightbox Modal ── */}
      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(6px)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative',
              maxWidth: '90vw',
              maxHeight: '90vh',
              background: '#000000',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
              boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
            }}
          >
            <button
              onClick={() => setLightboxUrl(null)}
              style={{
                position: 'absolute',
                top: 12,
                right: 12,
                background: 'rgba(0, 0, 0, 0.6)',
                color: '#FFFFFF',
                border: 'none',
                borderRadius: '50%',
                width: 36,
                height: 36,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                zIndex: 10,
              }}
            >
              <X size={20} />
            </button>
            <img
              src={lightboxUrl}
              alt="High resolution preview"
              style={{
                maxWidth: '90vw',
                maxHeight: '90vh',
                objectFit: 'contain',
                display: 'block',
              }}
            />
          </div>
        </div>
      )}

      {/* Laser scanline CSS keyframes */}
      <style>{`
        @keyframes scanline {
          0% {
            transform: translateY(0);
          }
          100% {
            transform: translateY(calc(100% - 3px));
          }
        }
      `}</style>
    </div>
  );
};
