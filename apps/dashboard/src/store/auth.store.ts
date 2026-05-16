import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { User, AuthTokens } from '@snaptrace/types';
import axios from 'axios';

const API_BASE_URL: string = (() => {
  try {
    return (import.meta as any).env?.VITE_API_URL ?? '/api';
  } catch {
    return '/api';
  }
})();

interface AuthStore {
  user: User | null;
  tokens: AuthTokens | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  setUser: (user: User) => void;
  setTokens: (tokens: AuthTokens) => void;
  setLoading: (loading: boolean) => void;
  login: (user: User, tokens: AuthTokens) => void;
  logout: () => void;
  updateUser: (partial: Partial<User>) => void;
  setTokensFromOAuth: (
    accessToken: string,
    refreshToken: string,
    expiresAt?: number,
  ) => Promise<void>;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: false,

      setUser: (user) => set({ user, isAuthenticated: true }),

      setTokens: (tokens) => {
        localStorage.setItem('snaptrace_access_token', tokens.accessToken);
        localStorage.setItem('snaptrace_refresh_token', tokens.refreshToken);
        set({ tokens });
      },

      setLoading: (isLoading) => set({ isLoading }),

      login: (user, tokens) => {
        localStorage.setItem('snaptrace_access_token', tokens.accessToken);
        localStorage.setItem('snaptrace_refresh_token', tokens.refreshToken);
        set({ user, tokens, isAuthenticated: true, isLoading: false });
      },

      logout: () => {
        localStorage.removeItem('snaptrace_access_token');
        localStorage.removeItem('snaptrace_refresh_token');
        set({ user: null, tokens: null, isAuthenticated: false, isLoading: false });
      },

      updateUser: (partial) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...partial } : null,
        })),

      setTokensFromOAuth: async (accessToken: string, refreshToken: string, expiresAt?: number) => {
        // Persist tokens to localStorage
        localStorage.setItem('snaptrace_access_token', accessToken);
        localStorage.setItem('snaptrace_refresh_token', refreshToken);

        const tokens: AuthTokens = {
          accessToken,
          refreshToken,
          expiresIn: expiresAt ? Math.floor((expiresAt - Date.now()) / 1000) : 900,
        };
        set({ tokens, isLoading: true });

        // Fetch the user from /api/auth/me using the access token
        try {
          const { data } = await axios.get<{ data: User }>(`${API_BASE_URL}/auth/me`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const user = data.data ?? (data as unknown as User);
          set({ user, isAuthenticated: true, isLoading: false });
        } catch (err) {
          // Clear on failure so we don't leave stale state
          localStorage.removeItem('snaptrace_access_token');
          localStorage.removeItem('snaptrace_refresh_token');
          set({ tokens: null, isAuthenticated: false, isLoading: false });
          throw err;
        }
      },
    }),
    {
      name: 'snaptrace_auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        user: state.user,
        tokens: state.tokens,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);
