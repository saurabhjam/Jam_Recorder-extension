import crypto from 'crypto';

import { customAlphabet, nanoid } from 'nanoid';

// ============================================================
// Secure Token Generation
// ============================================================

const urlSafeAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const generateUrlSafeId = customAlphabet(urlSafeAlphabet, 32);

/**
 * Generate a cryptographically secure random token.
 */
export function generateSecureToken(length = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate a URL-safe random token (no special characters).
 */
export function generateUrlSafeToken(length = 32): string {
  return generateUrlSafeId(length);
}

/**
 * Generate a short unique ID suitable for public sharing links.
 * e.g. "abc123xyz" style
 */
export function generateShareId(length = 12): string {
  const shortAlphabet = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', length);
  return shortAlphabet();
}

/**
 * Generate a unique ID using nanoid.
 */
export function generateId(length = 21): string {
  return nanoid(length);
}

/**
 * Generate a UUID v4.
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

// ============================================================
// Checksum / Hash Utilities
// ============================================================

/**
 * Calculate SHA-256 checksum of a buffer.
 */
export function calculateChecksum(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Calculate MD5 checksum (for Cloudinary compatibility).
 */
export function calculateMD5(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * Verify a buffer against its checksum.
 */
export function verifyChecksum(buffer: Buffer, expectedChecksum: string): boolean {
  const actualChecksum = calculateChecksum(buffer);
  return crypto.timingSafeEqual(
    Buffer.from(actualChecksum, 'hex'),
    Buffer.from(expectedChecksum, 'hex'),
  );
}

/**
 * Create an HMAC signature for webhook validation.
 */
export function createHmacSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify an HMAC signature in constant time.
 */
export function verifyHmacSignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmacSignature(payload, secret);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const signatureBuffer = Buffer.from(signature, 'hex');

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

// ============================================================
// Password Utilities
// ============================================================

/**
 * Generate a random password reset token.
 */
export function generatePasswordResetToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

/**
 * Generate a random verification token for email verification.
 */
export function generateVerificationToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================================
// Invite Token Utilities
// ============================================================

/**
 * Generate a team invite token.
 */
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// ============================================================
// Visitor ID Generation (for anonymous analytics)
// ============================================================

/**
 * Generate a stable visitor ID from request metadata (privacy-respecting fingerprint).
 */
export function generateVisitorId(ip: string, userAgent: string, salt: string): string {
  return crypto
    .createHash('sha256')
    .update(`${ip}:${userAgent}:${salt}`)
    .digest('hex')
    .slice(0, 16);
}
