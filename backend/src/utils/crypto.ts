/**
 * Cryptographic utilities for the inventory system.
 * - Password hashing via PBKDF2 (Workers-compatible, no external deps)
 * - Session token generation and hashing
 * - UUID generation
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

/** Hash a password using PBKDF2-SHA256. Returns "salt:hash" as hex strings. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LENGTH * 8
  );
  const hashHex = bufToHex(new Uint8Array(derivedBits));
  const saltHex = bufToHex(salt);
  return `${saltHex}:${hashHex}`;
}

/** Verify a password against a stored "salt:hash" string. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltHex, expectedHashHex] = storedHash.split(':');
  if (!saltHex || !expectedHashHex) return false;

  const salt = hexToBuf(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LENGTH * 8
  );
  const hashHex = bufToHex(new Uint8Array(derivedBits));
  return timingSafeEqual(hashHex, expectedHashHex);
}

/** Generate a cryptographically random session token (64 hex chars = 32 bytes). */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bufToHex(bytes);
}

/** Hash a session token with SHA-256 for storage. Raw token is NEVER stored in D1. */
export async function hashSessionToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(new Uint8Array(hash));
}

/** Generate a UUID v4. */
export function generateId(): string {
  return crypto.randomUUID();
}

/** Generate a cryptographically random idempotency key. */
export function generateIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bufToHex(bytes);
}

// --- Hex conversion helpers ---

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Timing-safe string comparison to prevent timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const aBuf = enc.encode(a);
  const bBuf = enc.encode(b);
  let result = 0;
  for (let i = 0; i < aBuf.length; i++) {
    result |= aBuf[i] ^ bBuf[i];
  }
  return result === 0;
}
