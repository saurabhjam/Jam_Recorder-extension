/**
 * BackgroundAuthManager — production-grade auth lifecycle for MV3 service workers.
 *
 * Key design decisions:
 *  - Uses chrome.alarms (persistent across SW termination) not setTimeout/setInterval.
 *  - Schedules refresh 2 minutes before token expiry so users never see 401s.
 *  - On startup, re-hydrates alarm from stored token if one isn't already set.
 *  - Broadcasts AUTH_STATE_CHANGED so the popup can re-render without polling.
 *  - All token storage is in chrome.storage.local (cookie-independent — required for extensions).
 */

import axios from 'axios';
import type { AuthTokens } from '@/types';
import { STORAGE_KEYS, AUTH_REFRESH_ALARM } from '@/types';
import { API_BASE_URL } from '@/config';

// ─── Config ───────────────────────────────────────────────────────────────────

/** Schedule refresh this many ms before expiry. */
const REFRESH_BUFFER_MS = 2 * 60 * 1000; // 2 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getStoredTokens(): Promise<AuthTokens | null> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
    return (result[STORAGE_KEYS.AUTH_TOKENS] as AuthTokens | undefined) ?? null;
  } catch {
    return null;
  }
}

function broadcastAuthState(isAuthenticated: boolean): void {
  chrome.runtime
    .sendMessage({
      type: 'AUTH_STATE_CHANGED',
      payload: { isAuthenticated },
    })
    .catch(() => {
      // Popup may be closed — safe to ignore
    });
}

// ─── Auth Manager ─────────────────────────────────────────────────────────────

export const authManager = {
  /**
   * Called on extension startup and install.
   * Re-creates the alarm if a valid token is already stored.
   */
  async initialize(): Promise<void> {
    const tokens = await getStoredTokens();
    if (!tokens) return;

    if (tokens.expiresAt > Date.now()) {
      await this.scheduleRefreshAlarm(tokens.expiresAt);
    } else {
      // Already expired — try to refresh immediately
      await this.performRefresh();
    }
  },

  /**
   * Schedule (or reschedule) the token-refresh alarm using chrome.alarms.
   * Alarms survive service worker termination, unlike setTimeout.
   */
  async scheduleRefreshAlarm(expiresAt: number): Promise<void> {
    const fireAt = expiresAt - REFRESH_BUFFER_MS;

    // Don't schedule in the past
    if (fireAt <= Date.now()) {
      await this.performRefresh();
      return;
    }

    await chrome.alarms.clear(AUTH_REFRESH_ALARM);
    chrome.alarms.create(AUTH_REFRESH_ALARM, { when: fireAt });
  },

  /**
   * Handle the refresh alarm firing.
   * Called from the alarms.onAlarm listener in background/index.ts.
   */
  async handleRefreshAlarm(): Promise<void> {
    await this.performRefresh();
  },

  /**
   * Perform the actual token refresh.
   * On success: stores new tokens and reschedules the alarm.
   * On failure: clears auth state and notifies the popup.
   */
  async performRefresh(): Promise<void> {
    const tokens = await getStoredTokens();
    if (!tokens?.refreshToken) {
      await this.clearAuth();
      return;
    }

    try {
      const response = await axios.post<{
        success: boolean;
        data: { tokens: AuthTokens };
      }>(
        `${API_BASE_URL}/auth/refresh`,
        { refreshToken: tokens.refreshToken },
        { timeout: 15_000 },
      );

      const newTokens = response.data.data.tokens;

      await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_TOKENS]: newTokens });

      // Reschedule for the new expiry
      await this.scheduleRefreshAlarm(newTokens.expiresAt);

      // Notify popup so it can update its in-memory accessToken
      chrome.runtime
        .sendMessage({
          type: 'TOKEN_REFRESHED',
          payload: { accessToken: newTokens.accessToken, expiresAt: newTokens.expiresAt },
        })
        .catch(() => {});
    } catch (err) {
      console.error('[AuthManager] Token refresh failed:', err);

      // Check if it's a network error vs auth error
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        // Refresh token itself is invalid — full logout
        await this.clearAuth();
      } else {
        // Transient error — retry in 30 seconds
        chrome.alarms.create(AUTH_REFRESH_ALARM, { delayInMinutes: 0.5 });
      }
    }
  },

  /**
   * Called when the popup sends a TOKEN_REFRESHED message after
   * a successful login/register so the background reschedules the alarm.
   */
  async onTokenRefreshed(expiresAt: number): Promise<void> {
    await this.scheduleRefreshAlarm(expiresAt);
  },

  /**
   * Called when the popup sends AUTH_STATE_CHANGED { isAuthenticated: false }
   * (user logged out) so the background cancels the alarm.
   */
  async onLogout(): Promise<void> {
    await chrome.alarms.clear(AUTH_REFRESH_ALARM);
  },

  /** Wipe all auth storage and notify popup. */
  async clearAuth(): Promise<void> {
    await chrome.alarms.clear(AUTH_REFRESH_ALARM);
    await chrome.storage.local.remove([
      STORAGE_KEYS.AUTH_USER,
      STORAGE_KEYS.AUTH_TOKENS,
      STORAGE_KEYS.AUTH_SESSION_ID,
    ]);
    broadcastAuthState(false);
  },
};
