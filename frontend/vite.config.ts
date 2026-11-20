import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/**
 * Writes dist/sw.js from sw/sw-template.js with the list of every built file (so the whole app is stored
 * on the phone at install and opens offline) and a version that changes with every deploy.
 * The scanner's 15 MB ONNX runtime is left out: scanning needs internet anyway.
 */
function serviceWorker(): Plugin {
  return {
    name: 'poonam-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => f !== 'sw.js' && !/ort-wasm[^/]*\.(wasm|mjs)$/.test(f) && !f.endsWith('.map') && !f.startsWith('ocr/'))
        .map((f) => '/' + f)
      const precache = ['/', ...files, '/manifest.json', '/favicon.svg', '/icons.svg']
      const version = createHash('sha256').update(precache.join('|')).digest('hex').slice(0, 12)
      const source = readFileSync(new URL('./sw/sw-template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(precache))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

/**
 * "Read ID from photo" engine (Tesseract, Apache-2.0), served from our own site under /ocr/v6/ — never from a CDN.
 * Not in the install-time precache: nobody downloads these ~7 MB unless they switch the ID reader on; the service
 * worker then keeps them for offline use (cache 'ocr-v6'). Dev: served straight from node_modules.
 */
const OCR_BASE = '/ocr/v6' // keep in sync with OCR_BASE in src/lib/ocr/idReader.ts and sw/sw-template.js
const OCR_FILES: Record<string, { from: string; type: string }> = {
  'worker.min.js': { from: 'tesseract.js/dist/worker.min.js', type: 'text/javascript' },
  'tesseract-core-simd-lstm.wasm.js': { from: 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js', type: 'text/javascript' },
  'tesseract-core-lstm.wasm.js': { from: 'tesseract.js-core/tesseract-core-lstm.wasm.js', type: 'text/javascript' },
  'eng.traineddata.gz': { from: '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', type: 'application/octet-stream' },
}
function ocrAssets(): Plugin {
  const path = (f: string) => new URL(`./node_modules/${OCR_FILES[f].from}`, import.meta.url)
  return {
    name: 'poonam-ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.startsWith(`${OCR_BASE}/`) ? req.url.slice(OCR_BASE.length + 1).split('?')[0] : null
        if (!name || !OCR_FILES[name]) return next()
        res.setHeader('Content-Type', OCR_FILES[name].type)
        // The app is cross-origin isolated (on-device database): a worker script without these headers is blocked
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
        res.end(readFileSync(path(name)))
      })
    },
    generateBundle() {
      for (const name of Object.keys(OCR_FILES)) {
        this.emitFile({ type: 'asset', fileName: `${OCR_BASE.slice(1)}/${name}`, source: readFileSync(path(name)) })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ocrAssets(), serviceWorker()],
  server: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8788',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  worker: {
    format: 'es',
  },
})
