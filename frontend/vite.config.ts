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
        .filter((f) => f !== 'sw.js' && !/ort-wasm[^/]*\.(wasm|mjs)$/.test(f) && !f.endsWith('.map'))
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), serviceWorker()],
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
