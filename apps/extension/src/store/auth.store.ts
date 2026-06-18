import { create } from 'zustand';
import { authApi } from '@/services/api';
import type { User, AuthTokens } from '@/types';
import { STORAGE_KEYS } from '@/types';

interface AuthStore {
  user: User | null;
  accessToken: string | null;
  sessionId: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (username: string, password: string) => Promise<void>;
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

      // Token expired → try to refresh
      try {
        await get().refreshToken();
        // refreshToken() updates accessToken in the store; mark session as authenticated
        set({ user, isAuthenticated: true });
      } catch {
        await chrome.storage.local.remove([
          STORAGE_KEYS.AUTH_USER,
          STORAGE_KEYS.AUTH_TOKENS,
          STORAGE_KEYS.AUTH_SESSION_ID,
        ]);
        set({ user: null, accessToken: null, sessionId: null, isAuthenticated: false });
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
      const { user, tokens, sessionId } = await authApi.login(username, password);

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

  refreshToken: async () => {
    const result = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
    const tokens = result[STORAGE_KEYS.AUTH_TOKENS] as AuthTokens | undefined;

    if (!tokens?.refreshToken) {
      throw new Error('No refresh token available');
    }

    const newTokens = await authApi.refreshToken(tokens.refreshToken);

    await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_TOKENS]: newTokens });

    // Reschedule refresh alarm in background
    chrome.runtime
      .sendMessage({
        type: 'TOKEN_REFRESHED',
        payload: { expiresAt: newTokens.expiresAt },
      })
      .catch(() => {});

    set({ accessToken: newTokens.accessToken });
  },

  clearError: () => set({ error: null }),
}));
