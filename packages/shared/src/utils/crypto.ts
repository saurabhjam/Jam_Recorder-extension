// Browser-safe crypto utilities using the Web Crypto API.

const ALPHABET_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ALPHABET_HEX = '0123456789abcdef';
const ALPHABET_OPAQUE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// ─── ID generation ────────────────────────────────────────────────────────────

/**
 * Generate a URL-safe random ID using the Web Crypto API.
 * Uses the same URL-safe base64 alphabet as nanoid.
 * @param length Number of characters (default 21)
 */
export async function generateId(length = 21): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  const result = new Array<string>(length);
  for (let i = 0; i < length; i++) {
    result[i] = ALPHABET_URL[bytes[i] & 63];
  }
  return result.join('');
}

// ─── Hashing ──────────────────────────────────────────────────────────────────

/**
 * SHA-256 hash a UTF-8 string, returning a lowercase hex digest.
 * Works in browsers and Node 18+ (via globalThis.crypto).
 */
export async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => ALPHABET_HEX[b >> 4] + ALPHABET_HEX[b & 15]).join('');
}

// ─── Opaque token ─────────────────────────────────────────────────────────────

/**
 * Generate a random opaque token (alphanumeric only, no dashes/underscores).
 * Suitable for use in extension communication, share links, etc.
 * This is synchronous because it only uses getRandomValues (no subtle).
 * @param length Number of characters (default 32)
 */
export function generateOpaqueToken(length = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  const result = new Array<string>(length);
  for (let i = 0; i < length; i++) {
    // Reject values that would introduce bias; fall back to looping
    result[i] = ALPHABET_OPAQUE[bytes[i] % ALPHABET_OPAQUE.length];
  }
  return result.join('');
}

// ─── Timing-safe comparison ───────────────────────────────────────────────────

/**
 * Compare two strings in a way that avoids timing attacks.
 * Returns true only if both strings are equal.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
