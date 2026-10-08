import { create } from 'zustand';
import { refreshTokens } from '@/services/tokens';
import { authApi } from '@/services/api';
import type { User, AuthTokens } from '@/types';
import { STORAGE_KEYS } from '@/types';

type ProfileOverride = Partial<Pick<User, 'name' | 'avatar'>>;

/** Read all per-user profile overrides ({ [login]: { name?, avatar? } }). */
async function getProfileOverrides(): Promise<Record<string, ProfileOverride>> {
  try {
    const r = await chrome.storage.local.get([STORAGE_KEYS.AUTH_PROFILE_OVERRIDES]);
    return (r[STORAGE_KEYS.AUTH_PROFILE_OVERRIDES] as Record<string, ProfileOverride>) ?? {};
  } catch {
    return {};
  }
}

/** Re-apply this user's locally-edited name/avatar on top of the server user so
 *  a fresh login doesn't clobber edits with stale server values. */
async function applyProfileOverrides(user: User): Promise<User> {
  const all = await getProfileOverrides();
  const override = all[user.login];
  return override ? { ...user, ...override } : user;
}

interface AuthStore {
  user: User | null;
  accessToken: string | null;
  sessionId: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (username: string, password: string) => Promise<void>;
  loginWithToken: (token: string) => Promise<void>;
  updateProfile: (updates: Partial<Pick<User, 'name' | 'avatar'>>) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<void>;
  initialize: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  accessToken: null,
  sessionId: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,

  initialize: async () => {
    set({ isLoading: true });
    try {
      const result = await chrome.storage.local.get([
        STORAGE_KEYS.AUTH_USER,
        STORAGE_KEYS.AUTH_TOKENS,
        STORAGE_KEYS.AUTH_SESSION_ID,
      ]);

      const user = result[STORAGE_KEYS.AUTH_USER] as User | undefined;
      const tokens = result[STORAGE_KEYS.AUTH_TOKENS] as AuthTokens | undefined;
      const sessionId = result[STORAGE_KEYS.AUTH_SESSION_ID] as string | undefined;

      if (!user || !tokens?.accessToken) {
        // No session — explicitly clear any stale Zustand state
        set({
          isLoading: false,
          isAuthenticated: false,
          user: null,
          accessToken: null,
          sessionId: null,
        });
        return;
      }

      // Token still valid → hydrate store immediately
      if (tokens.expiresAt > Date.now()) {
        set({
          user,
          accessToken: tokens.accessToken,
          sessionId: sessionId ?? null,
          isAuthenticated: true,
          isLoading: false,
        });
        return;
      }

      // Token expired → try to refresh.
      //
      // A refresh that merely could not happen — no network, the sign-in server
      // down, the popup opened on a train — must not sign anybody out. This
      // used to wipe the stored session on ANY failure, so opening the popup
      // offline with an expired token was enough to lose it. The shared refresh
      // clears the sign-in itself, and only when the server rejects the refresh
      // token; here, anything else leaves it exactly where it is to be retried.
      const outcome = await refreshTokens();
      if (outcome.ok) {
        set({
          user,
          accessToken: outcome.tokens.accessToken,
          sessionId: sessionId ?? null,
          isAuthenticated: true,
        });
      } else if (outcome.verdict === 'invalid' || outcome.verdict === 'no-refresh-token') {
        // tokens.ts has already cleared the sign-in for a definitive rejection.
        set({ user: null, accessToken: null, sessionId: null, isAuthenticated: false });
      } else {
        console.warn('[AuthStore] could not refresh yet — keeping the session:', outcome.error);
        set({
          user,
          accessToken: tokens.accessToken,
          sessionId: sessionId ?? null,
          isAuthenticated: true,
        });
      }
    } catch (err) {
      console.error('[AuthStore] Initialize error:', err);
    } finally {
      set({ isLoading: false });
    }
  },

  login: async (username: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const { user: serverUser, tokens, sessionId } = await authApi.login(username, password);
      const user = await applyProfileOverrides(serverUser);

      await chrome.storage.local.set({
        [STORAGE_KEYS.AUTH_USER]: user,
        [STORAGE_KEYS.AUTH_TOKENS]: tokens,
        [STORAGE_KEYS.AUTH_SESSION_ID]: sessionId,
      });

      // Notify background to schedule token refresh alarm
      chrome.runtime
        .sendMessage({
          type: 'TOKEN_REFRESHED',
          payload: { expiresAt: tokens.expiresAt },
        })
        .catch(() => {});

      set({
        user,
        accessToken: tokens.accessToken,
        sessionId,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed. Please try again.';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  loginWithToken: async (token: string) => {
    set({ isLoading: true, error: null });
    try {
      const { user: serverUser, tokens, sessionId } = await authApi.loginWithToken(token);
      const user = await applyProfileOverrides(serverUser);

      await chrome.storage.local.set({
        [STORAGE_KEYS.AUTH_USER]: user,
        [STORAGE_KEYS.AUTH_TOKENS]: tokens,
        [STORAGE_KEYS.AUTH_SESSION_ID]: sessionId,
      });

      // A pasted token has no refresh token, so we don't schedule a refresh
      // alarm. Just tell the background it's authenticated; on expiry the 401
      // handler clears auth and routes back to login.
      chrome.runtime
        .sendMessage({ type: 'AUTH_STATE_CHANGED', payload: { isAuthenticated: true } })
        .catch(() => {});

      set({
        user,
        accessToken: tokens.accessToken,
        sessionId,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed. Please try again.';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  updateProfile: async (updates: Partial<Pick<User, 'name' | 'avatar'>>) => {
    const { user } = get();
    if (!user) return;
    const next = { ...user, ...updates };
    // Update the store first so every popup view (footer, settings, avatars)
    // reflects the change immediately.
    set({ user: next });
    // Persist the current user AND record the edit as a per-user override so it
    // survives a fresh login (which otherwise re-fetches the old server values).
    const overrides = await getProfileOverrides();
    overrides[user.login] = { ...(overrides[user.login] ?? {}), ...updates };
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTH_USER]: next,
      [STORAGE_KEYS.AUTH_PROFILE_OVERRIDES]: overrides,
    });
  },

  register: async (email: string, password: string, name: string) => {
    set({ isLoading: true, error: null });
    try {
      const { user, tokens, sessionId } = await authApi.register(email, password, name);

      await chrome.storage.local.set({
        [STORAGE_KEYS.AUTH_USER]: user,
        [STORAGE_KEYS.AUTH_TOKENS]: tokens,
        [STORAGE_KEYS.AUTH_SESSION_ID]: sessionId,
      });

      chrome.runtime
        .sendMessage({
          type: 'TOKEN_REFRESHED',
          payload: { expiresAt: tokens.expiresAt },
        })
        .catch(() => {});

      set({
        user,
        accessToken: tokens.accessToken,
        sessionId,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed. Please try again.';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  logout: async () => {
    set({ isLoading: true });
    const { sessionId } = get();
    try {
      await authApi.logout(sessionId ?? undefined);
    } catch {
      // Ignore logout API errors — clear local state regardless
    } finally {
      await chrome.storage.local.remove([
        STORAGE_KEYS.AUTH_USER,
        STORAGE_KEYS.AUTH_TOKENS,
        STORAGE_KEYS.AUTH_SESSION_ID,
      ]);
      // Tell background to cancel the refresh alarm
      chrome.runtime
        .sendMessage({ type: 'AUTH_STATE_CHANGED', payload: { isAuthenticated: false } })
        .catch(() => {});
      set({
        user: null,
        accessToken: null,
        sessionId: null,
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },

  /**
   * Refresh through the one shared implementation (services/tokens.ts).
   *
   * Refreshing here on its own used to rotate the refresh token behind the
   * back of the service worker and the offscreen document, whose next attempt
   * was then rejected — and that rejection was what signed the person out.
   */
  refreshToken: async () => {
    const outcome = await refreshTokens();
    if (!outcome.ok) throw new Error(outcome.error ?? 'Could not refresh the sign-in');
    set({ accessToken: outcome.tokens.accessToken });
  },

  clearError: () => set({ error: null }),
}));
