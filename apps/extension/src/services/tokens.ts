/**
 * The one place a sign-in is refreshed.
 *
 * Before this module there were three: the axios interceptor, the background's
 * refresh alarm and the offscreen document, each with its own copy of the rules
 * and each wiping the stored sign-in when its attempt failed. Three realms
 * refreshing against a server that rotates refresh tokens is a race whose loser
 * is handed `invalid_grant` — and that loser logged the person out of a session
 * that was, at that instant, perfectly valid. Monitoring then had no token, so
 * everything it captured piled up locally and the session on the server went
 * silent until it was expired.
 *
 * So: one implementation, one refresh at a time across realms (a lock in
 * storage), a late loser re-reads the token the winner published instead of
 * failing, and the sign-in is cleared only when the server says the refresh
 * token itself is no longer valid.
 */

import type { AuthTokens } from '@/types';
import { STORAGE_KEYS } from '@/types';
import { SSO_AUTH_HEADER, SSO_TOKEN_URL } from '@/config';
import {
  AUTH_POLICY,
  classifyRefreshFailure,
  isExpired,
  needsRefresh,
  supersededBy,
  type RefreshVerdict,
} from '@/utils/authRefreshPolicy';

const LOCK_KEY = 'st_auth_refresh_lock';

/**
 * When the current sign-in began — not when it was last refreshed.
 *
 * Set once, by whichever path first stores tokens, and left alone by every
 * refresh afterwards. A refresh that reset it would make the session immortal:
 * the nightly sign-out asks "when did this person sign in", and the answer must
 * not be "four minutes ago, as always".
 */
const SIGNED_IN_AT_KEY = 'st_auth_signed_in_at';

export type RefreshOutcome =
  | { ok: true; tokens: AuthTokens; by: 'this-realm' | 'another-realm' }
  | { ok: false; verdict: RefreshVerdict | 'no-refresh-token'; error?: string };

/** Whoever asked first in this realm; the others await the same promise. */
let inFlight: Promise<RefreshOutcome> | null = null;

export async function readTokens(): Promise<AuthTokens | null> {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
    return (stored[STORAGE_KEYS.AUTH_TOKENS] as AuthTokens | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function writeTokens(tokens: AuthTokens): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_TOKENS]: tokens });
  await startSessionClock();
  broadcast('TOKEN_REFRESHED', { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
}

/**
 * Clear the sign-in. Monitoring is deliberately left alone: it keeps capturing
 * and keeps everything in its outbox, and uploads once the person signs in
 * again. Losing a token is not a reason to lose the day's record.
 */
/** Note when this sign-in began, if it is not already noted. */
export async function startSessionClock(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([SIGNED_IN_AT_KEY]);
    if (typeof stored[SIGNED_IN_AT_KEY] === 'number') return;
    await chrome.storage.local.set({ [SIGNED_IN_AT_KEY]: Date.now() });
  } catch {
    /* without it the nightly sign-out simply does not fire */
  }
}

/** When the current sign-in began, or null. */
export async function sessionStartedAt(): Promise<number | null> {
  try {
    const stored = await chrome.storage.local.get([SIGNED_IN_AT_KEY]);
    const at = stored[SIGNED_IN_AT_KEY];
    return typeof at === 'number' ? at : null;
  } catch {
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  await chrome.storage.local.remove([
    STORAGE_KEYS.AUTH_USER,
    STORAGE_KEYS.AUTH_TOKENS,
    STORAGE_KEYS.AUTH_SESSION_ID,
    SIGNED_IN_AT_KEY,
  ]);
  broadcast('AUTH_STATE_CHANGED', { isAuthenticated: false });
}

function broadcast(type: string, payload: unknown): void {
  try {
    void chrome.runtime.sendMessage({ type, payload })?.catch?.(() => {});
  } catch {
    /* no receiver, or no runtime in this context */
  }
}

/**
 * A usable access token, refreshed first if it is at or near expiry.
 *
 * Returns null only when there is nothing to work with — no sign-in stored, or
 * the server rejected the refresh token. A server that cannot be reached
 * returns the token on hand (callers treat the resulting 401 as an outage and
 * keep their data) rather than nothing.
 */
export async function getFreshAccessToken(options?: { force?: boolean }): Promise<string | null> {
  const tokens = await readTokens();
  if (!tokens?.accessToken) return null;

  const stale = options?.force === true || needsRefresh(tokens.expiresAt, Date.now());
  if (!stale) return tokens.accessToken;

  const outcome = await refreshTokens();
  if (outcome.ok) return outcome.tokens.accessToken;

  // Still inside its lifetime and only the refresh failed: the token on hand is
  // the best answer, and one more 401 is cheaper than giving up.
  if (!isExpired(tokens.expiresAt, Date.now())) return tokens.accessToken;
  return outcome.verdict === 'invalid' ? null : tokens.accessToken;
}

/** Refresh now, at most once at a time in this realm and across realms. */
export async function refreshTokens(): Promise<RefreshOutcome> {
  if (inFlight) return inFlight;
  inFlight = runRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runRefresh(): Promise<RefreshOutcome> {
  const attempted = await readTokens();
  if (!attempted?.refreshToken) {
    return { ok: false, verdict: 'no-refresh-token' };
  }

  const published = await waitForAnotherRealm(attempted);
  if (published) return { ok: true, tokens: published, by: 'another-realm' };

  await takeLock();
  try {
    // Re-read inside the lock: whoever held it a moment ago may have published
    // a new pair, and reusing the token we started with would rotate it away.
    const current = (await readTokens()) ?? attempted;
    if (
      current.accessToken !== attempted.accessToken &&
      !isExpired(current.expiresAt, Date.now())
    ) {
      return { ok: true, tokens: current, by: 'another-realm' };
    }

    const response = await fetch(SSO_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: SSO_AUTH_HEADER,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return await settleFailure(current, { status: response.status, body });
    }

    const sso = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!sso.access_token) {
      return await settleFailure(current, { status: response.status, body: 'no access_token' });
    }

    const tokens: AuthTokens = {
      ...current,
      accessToken: sso.access_token,
      refreshToken: sso.refresh_token || current.refreshToken,
      expiresAt: Date.now() + (sso.expires_in ?? 3600) * 1000,
    };
    await writeTokens(tokens);
    return { ok: true, tokens, by: 'this-realm' };
  } catch (err) {
    // Threw before any answer: no network, DNS, a timeout. Never a verdict.
    return await settleFailure(attempted, { status: 0, body: messageOf(err) });
  } finally {
    await releaseLock();
  }
}

/**
 * Decide what a failed attempt means, after checking whether another realm
 * already succeeded with a token this one has not seen yet.
 */
async function settleFailure(
  attempted: AuthTokens,
  failure: { status: number; body: unknown },
): Promise<RefreshOutcome> {
  const stored = await readTokens();
  const superseded = supersededBy(attempted, stored, Date.now());
  if (superseded && stored) {
    console.warn('[Auth] refresh raced another part of the extension — using its token');
    return { ok: true, tokens: stored, by: 'another-realm' };
  }

  const verdict = classifyRefreshFailure(failure);
  const detail = `${failure.status}: ${String(failure.body).slice(0, 200)}`;
  if (verdict === 'invalid') {
    console.warn('[Auth] the sign-in server rejected the refresh token —', detail);
    await clearTokens();
    return { ok: false, verdict, error: detail };
  }
  console.warn('[Auth] could not refresh the sign-in yet (keeping it) —', detail);
  return { ok: false, verdict, error: detail };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Cross-realm lock ─────────────────────────────────────────────────────────

async function waitForAnotherRealm(attempted: AuthTokens): Promise<AuthTokens | null> {
  const holder = await readLock();
  if (!holder) return null;

  const deadline = Date.now() + AUTH_POLICY.LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    await delay(AUTH_POLICY.LOCK_POLL_MS);
    const stored = await readTokens();
    if (stored && supersededBy(attempted, stored, Date.now())) return stored;
    if (!(await readLock())) return null;
  }
  return null;
}

async function readLock(): Promise<number | null> {
  try {
    const stored = await chrome.storage.local.get([LOCK_KEY]);
    const at = (stored[LOCK_KEY] as { at?: number } | undefined)?.at;
    if (typeof at !== 'number') return null;
    return Date.now() - at < AUTH_POLICY.LOCK_TTL_MS ? at : null;
  } catch {
    return null;
  }
}

async function takeLock(): Promise<void> {
  try {
    await chrome.storage.local.set({ [LOCK_KEY]: { at: Date.now() } });
  } catch {
    /* without the lock the rotation race is still recovered from */
  }
}

async function releaseLock(): Promise<void> {
  try {
    await chrome.storage.local.remove([LOCK_KEY]);
  } catch {
    /* it expires on its own */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
