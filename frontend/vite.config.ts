import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

/**
 * App version shown to users (agreed 2026-11-21): the number of commits on main (#48, #49 …) plus the short commit id,
 * so the owner and the client can see they are on the same version. Cloudflare Pages may check out only the latest
 * commit; the full history is then fetched to count. If that fails the number is left out (the commit id still shows).
 */
function appVersion(): { number: number | null; commit: string; built: string } {
  const git = (cmd: string) => execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).toString().trim()
  let number: number | null = null
  let commit = (process.env.CF_PAGES_COMMIT_SHA || '').slice(0, 7)
  try {
    if (git('rev-parse --is-shallow-repository') === 'true') {
      try {
        git('fetch --unshallow --quiet')
      } catch {
        /* keep going: the commit id alone is still shown */
      }
    }
    if (git('rev-parse --is-shallow-repository') !== 'true') number = Number(git('rev-list --count HEAD')) || null
    if (!commit) commit = git('rev-parse --short=7 HEAD')
  } catch {
    /* not a git checkout */
  }
  return { number, commit: commit || 'dev', built: new Date().toISOString() }
}
const APP_VERSION = appVersion()

/** Writes /version.json: the version of the app on the site, compared with the phone's own copy by "Check for updates". */
function versionFile(): Plugin {
  return {
    name: 'poonam-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(APP_VERSION) })
    },
  }
}

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
      const precache = ['/', ...files.filter((f) => f !== '/version.json'), '/manifest.json', '/favicon.svg', '/icons.svg']
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
  plugins: [react(), ocrAssets(), versionFile(), serviceWorker()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
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
