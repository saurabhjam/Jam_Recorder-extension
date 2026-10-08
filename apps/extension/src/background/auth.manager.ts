/**
 * BackgroundAuthManager — keeps the sign-in alive for a service worker that
 * nobody is watching.
 *
 * Two things were wrong here and both ended the same way, with monitoring
 * holding a day's data it could not upload:
 *
 *  1. It refreshed against `${API_BASE_URL}/auth/refresh`, an endpoint of the
 *     old Node backend that this deployment does not serve. Every scheduled
 *     refresh therefore failed, and an answer of 401 from whatever did reply
 *     was taken as "the person is signed out" and wiped the sign-in.
 *  2. The refresh was scheduled as a one-shot alarm at expiry minus two
 *     minutes. An alarm missed — a laptop asleep across that moment, an
 *     extension update, a worker torn down at the wrong instant — was never
 *     rescheduled, so the token simply ran out.
 *
 * Now it delegates to the one shared refresh (see services/tokens.ts) and
 * checks on a repeating alarm, so a missed check costs five minutes rather than
 * a sign-in. Signing out is left to that module, which does it only when the
 * server says the refresh token is no longer valid.
 */

import { AUTH_POLICY, needsRefresh, refreshRetryDelayMs } from '@/utils/authRefreshPolicy';
import { clearTokens, readTokens, refreshTokens, sessionStartedAt } from '@/services/tokens';
import { describeSignOut, sessionSignOutReason } from '@/utils/sessionLifetime';
import { AUTH_REFRESH_ALARM } from '@/types';

/** Consecutive failed attempts, for backoff while the server is unreachable. */
let failures = 0;

export const authManager = {
  /** Called on startup and install: make sure the repeating check exists. */
  async initialize(): Promise<void> {
    await this.ensureAlarm();
    const tokens = await readTokens();
    if (!tokens) return;
    // A machine that was switched off overnight comes back here first.
    if (await this.endSessionIfDue()) return;
    if (needsRefresh(tokens.expiresAt, Date.now())) await this.performRefresh();
  },

  /** A repeating alarm, created only when it is missing so it is not reset. */
  async ensureAlarm(): Promise<void> {
    try {
      const existing = await chrome.alarms.get(AUTH_REFRESH_ALARM);
      if (existing?.periodInMinutes === AUTH_POLICY.CHECK_INTERVAL_MINUTES) return;
      await chrome.alarms.clear(AUTH_REFRESH_ALARM);
      chrome.alarms.create(AUTH_REFRESH_ALARM, {
        periodInMinutes: AUTH_POLICY.CHECK_INTERVAL_MINUTES,
        delayInMinutes: AUTH_POLICY.CHECK_INTERVAL_MINUTES,
      });
    } catch (err) {
      console.warn('[AuthManager] could not schedule the sign-in check:', err);
    }
  },

  /**
   * Kept for callers that used to pass an expiry. The check is periodic now, so
   * there is nothing to schedule; an expiry already inside the buffer is
   * refreshed immediately.
   */
  async scheduleRefreshAlarm(expiresAt: number): Promise<void> {
    await this.ensureAlarm();
    if (needsRefresh(expiresAt, Date.now())) await this.performRefresh();
  },

  /** The repeating alarm fired: refresh only if the token is near expiry. */
  async handleRefreshAlarm(): Promise<void> {
    const tokens = await readTokens();
    if (!tokens?.accessToken) return;
    if (await this.endSessionIfDue()) return;
    if (!needsRefresh(tokens.expiresAt, Date.now())) {
      failures = 0;
      return;
    }
    await this.performRefresh();
  },

  /**
   * Refresh now.
   *
   * A failure that is not a verdict on the sign-in schedules a sooner retry and
   * leaves everything in place; the periodic alarm is the backstop if even that
   * retry is lost.
   */
  async performRefresh(): Promise<void> {
    const outcome = await refreshTokens();
    if (outcome.ok) {
      failures = 0;
      await this.ensureAlarm();
      return;
    }
    if (outcome.verdict === 'invalid' || outcome.verdict === 'no-refresh-token') {
      failures = 0;
      return;
    }
    failures += 1;
    const delayMinutes = refreshRetryDelayMs(failures) / 60_000;
    try {
      chrome.alarms.create(AUTH_REFRESH_ALARM, {
        delayInMinutes: Math.max(delayMinutes, 0.5),
        periodInMinutes: AUTH_POLICY.CHECK_INTERVAL_MINUTES,
      });
    } catch {
      /* the next periodic check covers it */
    }
  },

  /** The popup signed in or refreshed: make sure the check is running. */
  async onTokenRefreshed(_expiresAt: number): Promise<void> {
    failures = 0;
    await this.ensureAlarm();
  },

  /**
   * End the sign-in if policy says it is time — overnight, or at the age limit.
   *
   * Deliberate, and nothing to do with the failures that used to sign people
   * out: monitoring keeps running and keeps everything it captures, and the
   * next sign-in uploads it. Checked on the same five-minute alarm as the
   * refresh, and again at startup, so a machine that was off at two in the
   * morning is signed out the first time it is used instead of never.
   */
  async endSessionIfDue(): Promise<boolean> {
    const reason = sessionSignOutReason({
      signedInAt: await sessionStartedAt(),
      nowMs: Date.now(),
    });
    if (!reason) return false;
    console.log(`[AuthManager] ending the sign-in (${reason}) — ${describeSignOut(reason)}`);
    await clearTokens();
    return true;
  },

  /** The person signed out deliberately. */
  async onLogout(): Promise<void> {
    failures = 0;
    try {
      await chrome.alarms.clear(AUTH_REFRESH_ALARM);
    } catch {
      /* nothing to clear */
    }
  },

  /** Wipe the sign-in. Monitoring keeps its outbox either way. */
  async clearAuth(): Promise<void> {
    await this.onLogout();
    await clearTokens();
  },
};
