import type { Env } from '../types';

/**
 * The cloud Llama visual-search pipeline ("Scan Jewelry") is off unless LLAMA_SCAN_ENABLED is exactly "true".
 * Off means: its routes answer 503 and photo uploads no longer call Workers AI (0 neurons).
 * The code stays compiled so it can be switched back on (frontend: src/config/features.ts; git tag llama-scan-v3).
 */
export function isLlamaScanEnabled(env: Pick<Env, 'LLAMA_SCAN_ENABLED'>): boolean {
  return env.LLAMA_SCAN_ENABLED === 'true';
}
