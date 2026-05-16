/**
 * Check whether a string is a valid email address.
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  // RFC 5322-inspired pattern (practical subset)
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email.trim());
}

// ─── Password strength ────────────────────────────────────────────────────────

interface PasswordStrengthResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate password strength and return a list of errors if weak.
 */
export function isStrongPassword(password: string): PasswordStrengthResult {
  const errors: string[] = [];

  if (!password || typeof password !== 'string') {
    return { valid: false, errors: ['Password is required'] };
  }

  if (password.length < 8) {
    errors.push('Must be at least 8 characters');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Must contain an uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Must contain a lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Must contain a number');
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push('Must contain a special character (e.g. !@#$)');
  }

  return { valid: errors.length === 0, errors };
}

// ─── URL ──────────────────────────────────────────────────────────────────────

/**
 * Check whether a string is a valid HTTP/HTTPS URL.
 */
export function isValidUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ─── Convenience ─────────────────────────────────────────────────────────────

/**
 * Check whether a string is non-empty after trimming.
 */
export function isNonEmpty(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Check whether a value is a finite number within optional bounds.
 */
export function isInRange(value: number, min = -Infinity, max = Infinity): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}
