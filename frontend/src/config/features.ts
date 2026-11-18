/**
 * Feature switches.
 *
 * LLAMA_SCAN_ENABLED — the cloud "Scan Jewelry" pipeline (Llama 3.2 Vision → text → BGE embedding).
 * Switched off on 2026-11-18: on-device DINO scan is more accurate and faster, and costs 0 neurons.
 * The code is kept compiled and type-checked so it can be switched back on. To switch back:
 *   1. set this to true,
 *   2. set LLAMA_SCAN_ENABLED to "true" in backend/wrangler.jsonc (vars) and deploy the backend,
 *   3. open Scan Jewelry → Index → "Re-index all" once (the catalog will have changed meanwhile).
 * Git tag `llama-scan-v3` marks the last version where it was live.
 */
export const LLAMA_SCAN_ENABLED = false;
