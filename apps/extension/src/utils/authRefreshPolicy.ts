/**
 * When to refresh a sign-in, and when a failed refresh means the person is
 * really signed out — with no I/O, so the rules can be tested directly.
 *
 * ── The promise this file exists to keep ─────────────────────────────────────
 * Being signed out is destructive here: monitoring cannot upload, and the
 * person must notice and act before anything moves again. So it takes an answer
 * from the sign-in server saying "this refresh token is no longer valid".
 * Everything else — no network, a 502 from a gateway, a timeout, a load
 * balancer serving an error page, bad client credentials after a config change
 * — means "later", and the tokens are kept.
 */

export const AUTH_POLICY = {
  /**
   * Refresh this long before the access token expires — comfortably more than
   * the gap between two checks, so a token cannot lapse between them.
   */
  REFRESH_BUFFER_MS: 10 * 60_000,

  /**
   * How often the background checks the sign-in.
   *
   * A repeating alarm rather than one scheduled for the expiry: a one-shot
   * alarm that is lost — a worker torn down at the wrong moment, a laptop
   * asleep across the fire time, an extension update — is never noticed, and
   * the first thing the person sees is an expired sign-in hours later.
   */
  CHECK_INTERVAL_MINUTES: 5,

  /** Backoff between retries while the sign-in server cannot be reached. */
  RETRY_BACKOFF_MS: [15_000, 30_000, 60_000, 120_000, 300_000],

  /**
   * How long one realm's refresh blocks the others.
   *
   * The popup, the offscreen document and the service worker are separate
   * scripts with separate memory, so "only one refresh at a time" has to be
   * agreed through storage. The TTL is what keeps a realm that was closed
   * mid-refresh from blocking the rest forever.
   */
  LOCK_TTL_MS: 30_000,

  /** How long a realm waits for whoever holds the lock to publish a token. */
  LOCK_WAIT_MS: 12_000,
  LOCK_POLL_MS: 300,
} as const;

/** What a failed refresh means for the stored sign-in. */
export type RefreshVerdict = 'retry' | 'invalid';

/**
 * Was the refresh token itself rejected, or did the attempt merely fail?
 *
 * Only OAuth's own "this grant is no longer usable" answers count as a
 * rejection. A 401 at the token endpoint is ambiguous — it is also what a wrong
 * client secret returns — so on its own it is not treated as the person being
 * signed out.
 */
export function classifyRefreshFailure(failure: {
  status: number;
  body?: unknown;
}): RefreshVerdict {
  const text = textOf(failure.body).toLowerCase();
  if (/invalid_grant|invalid_token|refresh token (is )?(expired|revoked|invalid)/.test(text)) {
    return 'invalid';
  }
  // Transport, gateway and server-side failures are never a verdict on the
  // person's sign-in.
  if (failure.status === 0 || failure.status === 408 || failure.status >= 500) return 'retry';
  return 'retry';
}

function textOf(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'object') {
    const record = body as { error?: unknown; error_description?: unknown; message?: unknown };
    return [record.error, record.error_description, record.message]
      .filter((part) => typeof part === 'string')
      .join(' ');
  }
  return String(body);
}

/** Is this access token close enough to expiry to be refreshed now? */
export function needsRefresh(
  expiresAt: number | null | undefined,
  nowMs: number,
  bufferMs: number = AUTH_POLICY.REFRESH_BUFFER_MS,
): boolean {
  if (expiresAt == null || !Number.isFinite(expiresAt)) return true;
  return expiresAt - bufferMs <= nowMs;
}

/** Is this access token unusable right now (expired, or about to be)? */
export function isExpired(
  expiresAt: number | null | undefined,
  nowMs: number,
  slackMs = 10_000,
): boolean {
  if (expiresAt == null || !Number.isFinite(expiresAt)) return true;
  return expiresAt - slackMs <= nowMs;
}

/** Delay before trying an unreachable sign-in server again. */
export function refreshRetryDelayMs(consecutiveFailures: number): number {
  const ladder = AUTH_POLICY.RETRY_BACKOFF_MS;
  const index = Math.min(Math.max(consecutiveFailures, 1), ladder.length) - 1;
  return ladder[index];
}

/**
 * Did another realm refresh while this one was failing?
 *
 * The sign-in server rotates refresh tokens: the first caller gets a new pair
 * and every other caller's token stops working. That is not the person being
 * signed out — it is this realm being a moment late — so a failure is checked
 * against what is in storage now before it is believed.
 */
export function supersededBy(
  attempted: { refreshToken: string } | null,
  stored: { refreshToken: string; accessToken: string; expiresAt: number } | null,
  nowMs: number,
): string | null {
  if (!stored?.accessToken || !attempted) return null;
  if (stored.refreshToken === attempted.refreshToken) return null;
  return isExpired(stored.expiresAt, nowMs) ? null : stored.accessToken;
}
