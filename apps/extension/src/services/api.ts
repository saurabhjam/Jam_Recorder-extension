import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import type {
  ApiResponse,
  AuthTokens,
  LoginResponse,
  PaginatedResponse,
  Recording,
  RecordingMetadata,
  InitUploadResponse,
  ChunkUploadResponse,
  FinalizeUploadResponse,
  User,
  BackendRecordingType,
} from '@/types';
import { STORAGE_KEYS, toBackendRecordingType } from '@/types';

// ─── Base URL ─────────────────────────────────────────────────────────────────
const API_BASE_URL: string = (() => {
  try {
    const fromEnv = (import.meta as { env?: Record<string, string> }).env?.['VITE_API_BASE_URL'];
    return fromEnv ?? 'http://localhost:4000/api';
  } catch {
    return 'http://localhost:4000/api';
  }
})();

// ─── Error Extraction ─────────────────────────────────────────────────────────

/** Pull a human-readable message out of any Axios error response. */
function extractErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err) && err.response?.data) {
    const data = err.response.data as {
      message?: string;
      error?: string;
      details?: Array<{ message: string }>;
    };
    if (data.details && data.details.length > 0) {
      return data.details.map((d) => d.message).join(', ');
    }
    return data.message ?? data.error ?? fallback;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

// ─── Token Refresh Queue ──────────────────────────────────────────────────────

let isRefreshing = false;
let refreshSubscribers: Array<(token: string) => void> = [];

function subscribeTokenRefresh(cb: (token: string) => void): void {
  refreshSubscribers.push(cb);
}

function onRefreshed(token: string): void {
  refreshSubscribers.forEach((cb) => cb(token));
  refreshSubscribers = [];
}

function onRefreshFailed(): void {
  refreshSubscribers = [];
}

// ─── Axios Instance ───────────────────────────────────────────────────────────

const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

// ─── Request Interceptor ──────────────────────────────────────────────────────

apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    try {
      const result = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
      const tokens = result[STORAGE_KEYS.AUTH_TOKENS] as AuthTokens | undefined;
      if (tokens?.accessToken) {
        config.headers.Authorization = `Bearer ${tokens.accessToken}`;
      }
    } catch {
      // Running outside extension context (tests, offscreen with mock)
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// ─── Response Interceptor — Token Refresh ────────────────────────────────────

apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // Never try to refresh for auth endpoints — propagate the original error
    const reqUrl = (originalRequest.url ?? '').toLowerCase();
    const isAuthEndpoint =
      reqUrl.includes('/auth/login') ||
      reqUrl.includes('/auth/register') ||
      reqUrl.includes('/auth/refresh');

    if (error.response?.status !== 401 || originalRequest._retry || isAuthEndpoint) {
      return Promise.reject(error);
    }

    // Queue concurrent 401s while a refresh is in flight
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        subscribeTokenRefresh((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          resolve(apiClient(originalRequest));
        });
        setTimeout(() => reject(new Error('Token refresh timeout')), 15_000);
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      const stored = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
      const currentTokens = stored[STORAGE_KEYS.AUTH_TOKENS] as AuthTokens | undefined;

      if (!currentTokens?.refreshToken) {
        throw new Error('No refresh token available');
      }

      // Call refresh — backend returns full token pair in body
      const response = await axios.post<ApiResponse<{ tokens: AuthTokens }>>(
        `${API_BASE_URL}/auth/refresh`,
        { refreshToken: currentTokens.refreshToken },
      );

      const newTokens = response.data.data.tokens;

      await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_TOKENS]: newTokens });

      onRefreshed(newTokens.accessToken);
      originalRequest.headers.Authorization = `Bearer ${newTokens.accessToken}`;
      return apiClient(originalRequest);
    } catch (refreshError) {
      onRefreshFailed();
      // Clear stale auth data — popup will redirect to login
      await chrome.storage.local.remove([
        STORAGE_KEYS.AUTH_USER,
        STORAGE_KEYS.AUTH_TOKENS,
        STORAGE_KEYS.AUTH_SESSION_ID,
      ]);
      chrome.runtime
        .sendMessage({ type: 'AUTH_STATE_CHANGED', payload: { isAuthenticated: false } })
        .catch(() => {});
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);

// ─── Auth API ─────────────────────────────────────────────────────────────────

export const authApi = {
  /**
   * Authenticate via the external ReportPortal OAuth endpoint.
   * The backend calls /uat/sso/oauth/token, upserts the user, and returns
   * our own session tokens alongside the external bearer token.
   */
  login: async (username: string, password: string): Promise<LoginResponse> => {
    try {
      const response = await apiClient.post<ApiResponse<LoginResponse>>('/auth/external-login', {
        username,
        password,
      });
      return response.data.data;
    } catch (err) {
      throw new Error(extractErrorMessage(err, 'Login failed. Please try again.'));
    }
  },

  register: async (email: string, password: string, name: string): Promise<LoginResponse> => {
    try {
      const response = await apiClient.post<ApiResponse<LoginResponse>>('/auth/register', {
        email,
        password,
        name,
      });
      return response.data.data;
    } catch (err) {
      throw new Error(extractErrorMessage(err, 'Registration failed. Please try again.'));
    }
  },

  logout: async (sessionId?: string, logoutAll = false): Promise<void> => {
    try {
      await apiClient.post('/auth/logout', { sessionId, logoutAll });
    } catch {
      // Ignore logout errors — local state will be cleared regardless
    }
  },

  refreshToken: async (refreshToken: string): Promise<AuthTokens> => {
    const response = await apiClient.post<ApiResponse<{ tokens: AuthTokens }>>('/auth/refresh', {
      refreshToken,
    });
    return response.data.data.tokens;
  },

  getMe: async (): Promise<User> => {
    const response = await apiClient.get<ApiResponse<User>>('/auth/me');
    return response.data.data;
  },

  updateProfile: async (updates: { name?: string; avatar?: string | null }): Promise<User> => {
    const response = await apiClient.put<ApiResponse<User>>('/auth/me', updates);
    return response.data.data;
  },
};

// ─── Recordings API ───────────────────────────────────────────────────────────

export interface CreateRecordingPayload {
  title: string;
  type: BackendRecordingType;
  totalChunks: number;
  mimeType: string;
}

export const recordingsApi = {
  create: async (payload: CreateRecordingPayload): Promise<Recording> => {
    const response = await apiClient.post<ApiResponse<Recording>>('/recordings', payload);
    return response.data.data;
  },

  list: async (page = 1, limit = 20, type?: string): Promise<PaginatedResponse<Recording>> => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      ...(type ? { type } : {}),
    });
    const response = await apiClient.get<PaginatedResponse<Recording>>(`/recordings?${params}`);
    return response.data;
  },

  get: async (id: string): Promise<Recording> => {
    const response = await apiClient.get<ApiResponse<Recording>>(`/recordings/${id}`);
    return response.data.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/recordings/${id}`);
  },

  updateTitle: async (id: string, title: string): Promise<Recording> => {
    const response = await apiClient.patch<ApiResponse<Recording>>(`/recordings/${id}`, { title });
    return response.data.data;
  },

  search: async (query: string): Promise<Recording[]> => {
    const response = await apiClient.get<ApiResponse<Recording[]>>(
      `/recordings?search=${encodeURIComponent(query)}`,
    );
    return response.data.data;
  },
};

// ─── Upload API ───────────────────────────────────────────────────────────────
// Backend endpoints:
//   POST   /uploads/initiate    body: { recordingId, totalChunks, mimeType }
//   POST   /uploads/chunk       query: { recordingId, chunkIndex, totalChunks }  multipart
//   POST   /uploads/complete/:recordingId
//   DELETE /uploads/abort/:recordingId

export const uploadApi = {
  /**
   * Phase 1 — create the Recording row in the DB and get a recordingId.
   * Phase 2 — initiate the chunk-upload session.
   * Returns the recordingId to use for subsequent chunk calls.
   */
  initUpload: async (metadata: RecordingMetadata): Promise<InitUploadResponse> => {
    const payload = metadata as RecordingMetadata & { totalChunks?: number };
    const resolvedChunks = payload.totalChunks ?? 1;

    // Create recording row
    const recording = await recordingsApi.create({
      title: metadata.title,
      type: toBackendRecordingType(metadata.type),
      totalChunks: resolvedChunks,
      mimeType: metadata.mimeType,
    });

    // Initiate the upload session
    await apiClient.post('/uploads/initiate', {
      recordingId: recording.id,
      totalChunks: resolvedChunks,
      mimeType: metadata.mimeType,
    });

    return { recordingId: recording.id };
  },

  uploadChunk: async (
    recordingId: string,
    chunkIndex: number,
    totalChunks: number,
    chunk: Blob,
    onUploadProgress?: (percent: number) => void,
  ): Promise<ChunkUploadResponse> => {
    const formData = new FormData();
    formData.append('chunk', chunk, `chunk-${chunkIndex}`);

    const response = await apiClient.post<ApiResponse<ChunkUploadResponse>>(
      `/uploads/chunk?recordingId=${encodeURIComponent(recordingId)}&chunkIndex=${chunkIndex}&totalChunks=${totalChunks}`,
      formData,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (evt) => {
          if (evt.total && onUploadProgress) {
            onUploadProgress(Math.round((evt.loaded * 100) / evt.total));
          }
        },
      },
    );
    return response.data.data;
  },

  finalizeUpload: async (recordingId: string): Promise<FinalizeUploadResponse> => {
    const response = await apiClient.post<ApiResponse<FinalizeUploadResponse>>(
      `/uploads/complete/${encodeURIComponent(recordingId)}`,
    );
    return response.data.data;
  },

  cancelUpload: async (recordingId: string): Promise<void> => {
    await apiClient.delete(`/uploads/abort/${encodeURIComponent(recordingId)}`);
  },
};

// ─── Bug Reports API ──────────────────────────────────────────────────────────

export interface BugReportPayload {
  title: string;
  description: string;
  screenshotDataUrl?: string | null;
  annotatedScreenshotDataUrl?: string | null;
  browserInfo: Record<string, unknown>;
  consoleLogs: unknown[];
  networkLogs: unknown[];
}

export interface BugReportResponse {
  id: string;
  shareUrl: string;
  createdAt: string;
}

export const bugReportsApi = {
  create: async (payload: BugReportPayload): Promise<BugReportResponse> => {
    const response = await apiClient.post<ApiResponse<BugReportResponse>>('/bug-reports', payload);
    return response.data.data;
  },
};

export const api = {
  recordings: {
    createBugReport: (payload: BugReportPayload) => bugReportsApi.create(payload),
  },
};

// ─── Shares API ───────────────────────────────────────────────────────────────

export const sharesApi = {
  getShareUrl: async (recordingId: string): Promise<string> => {
    const response = await apiClient.get<ApiResponse<{ url: string }>>(
      `/recordings/${recordingId}/share`,
    );
    return response.data.data.url;
  },

  createPublicLink: async (recordingId: string): Promise<string> => {
    const response = await apiClient.post<ApiResponse<{ url: string }>>(
      `/recordings/${recordingId}/share`,
    );
    return response.data.data.url;
  },
};

export default apiClient;
