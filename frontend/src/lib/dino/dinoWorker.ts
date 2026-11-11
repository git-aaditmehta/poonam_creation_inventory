/// <reference lib="webworker" />
/**
 * DINOv2 Web Worker — keeps the 88 MB model and inference off the UI thread.
 *
 * Messages in:
 *   { type: 'load', id, modelUrl, sha256, cacheName, expectedBytes }
 *   { type: 'embed', id, pixels: Float32Array (1x3xHxW, normalised), size }
 * Messages out:
 *   { type: 'progress', loaded, total }
 *   { type: 'loaded', id, backend, loadMs, fromCache, downloadMs }
 *   { type: 'embedded', id, vector: Float32Array(384), inferenceMs }
 *   { type: 'error', id, message }
 */
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import wasmMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';

declare const self: DedicatedWorkerGlobalScope;

let session: ort.InferenceSession | null = null;
let backend: 'webgpu' | 'wasm' | null = null;
let loading: Promise<void> | null = null;
let forceWasm = false; // set by the load message (e.g. int8 model: runs best on the CPU kernels)

/**
 * iPhone/iPad (all iOS browsers are WebKit) and desktop Safari: Safari kills a tab that uses too much
 * memory, and its WebGPU + multi-threaded WASM support is the least stable. On WebKit we therefore
 * use single-threaded WASM on the CPU; Chrome/Android/desktop keep WebGPU with multi-threaded fallback.
 */
const ua = navigator.userAgent;
const isWebKit = /iPhone|iPad|iPod/.test(ua) || (/Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/.test(ua));

ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmMjsUrl };
// Multi-threaded WASM needs cross-origin isolation (Vercel sends COOP/COEP headers)
ort.env.wasm.numThreads =
  isWebKit || !self.crossOriginIsolated ? 1 : Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));

const post = (msg: any, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Model bytes from the Cache API if present, else download with progress and verify the checksum. */
async function getModelBytes(
  url: string,
  sha256: string,
  cacheName: string,
  expectedBytes: number
): Promise<{ bytes: ArrayBuffer; fromCache: boolean; downloadMs: number }> {
  let cache: Cache | null = null;
  try {
    // Free storage held by older model versions (e.g. the 88 MB fp32 model)
    for (const name of await caches.keys()) {
      if (name.startsWith('dino-model') && name !== cacheName) await caches.delete(name);
    }
    cache = await caches.open(cacheName);
    const hit = await cache.match(url);
    if (hit) {
      const bytes = await hit.arrayBuffer();
      if (bytes.byteLength === expectedBytes) return { bytes, fromCache: true, downloadMs: 0 };
      await cache.delete(url); // truncated/corrupt cache entry → download again
    }
  } catch {
    cache = null; // Cache API unavailable (private mode etc.) → just download
  }

  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`Model download failed (HTTP ${res.status})`);
  const total = expectedBytes;

  // Let the browser write its own copy to the Cache API while we read ours (no extra JS copy)
  let cacheWrite: Promise<void> | null = null;
  if (cache) {
    cacheWrite = cache.put(url, res.clone()).catch(() => undefined); // storage full → just downloads again next time
  }

  // Read straight into ONE preallocated buffer (the old code held chunks + a merged copy: 2x memory)
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let loaded = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > total) {
      await reader.cancel();
      throw new Error('Model file is larger than expected. Please refresh the app.');
    }
    out.set(value, loaded);
    loaded += value.length;
    const now = performance.now();
    if (now - lastPost > 150) {
      lastPost = now;
      post({ type: 'progress', loaded, total });
    }
  }
  post({ type: 'progress', loaded, total });
  const downloadMs = Math.round(performance.now() - t0);

  const ok = loaded === expectedBytes && (await sha256Hex(out.buffer)) === sha256;
  if (cacheWrite) await cacheWrite;
  if (!ok) {
    try {
      await cache?.delete(url);
    } catch {
      /* ignore */
    }
    throw new Error('Model file is incomplete or corrupted. Please retry on a stable connection.');
  }
  return { bytes: out.buffer, fromCache: false, downloadMs };
}

async function createSession(bytes: ArrayBuffer): Promise<void> {
  const hasWebGPU = !isWebKit && !forceWasm && typeof (navigator as any).gpu !== 'undefined';
  if (hasWebGPU) {
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter) {
        session = await ort.InferenceSession.create(new Uint8Array(bytes), {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        });
        backend = 'webgpu';
        return;
      }
    } catch (e) {
      console.warn('[DINO] WebGPU unavailable, falling back to WASM:', e);
    }
  }
  session = await ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  backend = 'wasm';
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      const t0 = performance.now();
      let info = { fromCache: true, downloadMs: 0 };
      if (!session) {
        if (!loading) {
          forceWasm = Boolean(msg.forceWasm);
          loading = (async () => {
            const r = await getModelBytes(msg.modelUrl, msg.sha256, msg.cacheName, msg.expectedBytes);
            info = { fromCache: r.fromCache, downloadMs: r.downloadMs };
            await createSession(r.bytes); // r.bytes is released after this (ORT keeps its own copy)
          })();
        }
        try {
          await loading;
        } catch (e) {
          loading = null; // allow Retry
          throw e;
        }
      }
      post({ type: 'loaded', id: msg.id, backend, loadMs: Math.round(performance.now() - t0), ...info });
      return;
    }

    if (msg.type === 'info') {
      post({ type: 'info', id: msg.id, isWebKit, numThreads: ort.env.wasm.numThreads, crossOriginIsolated: self.crossOriginIsolated });
      return;
    }

    if (msg.type === 'embed') {
      if (!session) throw new Error('Model not loaded');
      const size: number = msg.size;
      const input = new ort.Tensor('float32', msg.pixels as Float32Array, [1, 3, size, size]);
      const t0 = performance.now();
      const out = await session.run({ pixel_values: input });
      input.dispose?.();
      const hidden = out.last_hidden_state; // [1, tokens, 384]; token 0 = CLS (already layer-normed)
      const dims = hidden.dims;
      const width = dims[dims.length - 1];
      const data = (await hidden.getData()) as Float32Array;
      const cls = new Float32Array(width);
      let norm = 0;
      for (let i = 0; i < width; i++) {
        cls[i] = data[i];
        norm += data[i] * data[i];
      }
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < width; i++) cls[i] /= norm;
      hidden.dispose?.();
      post({ type: 'embedded', id: msg.id, vector: cls, inferenceMs: Math.round(performance.now() - t0) }, [cls.buffer]);
      return;
    }
  } catch (e: any) {
    post({ type: 'error', id: msg.id, message: e?.message || String(e) });
  }
};
