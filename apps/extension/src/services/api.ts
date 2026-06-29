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
  AssignedProject,
} from '@/types';
import { STORAGE_KEYS, toBackendRecordingType } from '@/types';
import { API_BASE_URL as REPORTS_API_URL, SSO_TOKEN_URL, SSO_AUTH_HEADER } from '@/config';

// ─── Base URLs ────────────────────────────────────────────────────────────────

// ReportPortal Java API — recordings, uploads, and user info
const PROJECT = 'superadmin_personal';

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

// ─── SSO Helpers ──────────────────────────────────────────────────────────────

interface SsoTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  jti: string;
}

interface RpUserResponse {
  id: number;
  userId: string; // RP's login name — confusingly called "userId"
  email: string;
  fullName: string;
  photoId: string | null;
  userRole: string;
  active: boolean;
  assignedProjects?: Record<string, AssignedProject>;
}

async function callSso(params: Record<string, string>): Promise<SsoTokenResponse> {
  const res = await axios.post<SsoTokenResponse>(
    SSO_TOKEN_URL,
    new URLSearchParams(params).toString(),
    {
      headers: {
        Authorization: SSO_AUTH_HEADER,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    },
  );
  return res.data;
}

async function fetchRpUser(accessToken: string): Promise<User> {
  const res = await axios.get<RpUserResponse>(`${REPORTS_API_URL}/users`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const r = res.data;
  return {
    id: String(r.id),
    login: r.userId,
    email: r.email,
    name: r.fullName ?? r.userId,
    avatar: r.photoId ?? null,
    role: r.userRole,
    isActive: r.active,
    assignedProjects: r.assignedProjects,
  };
}

// ─── Axios Instance ───────────────────────────────────────────────────────────

const apiClient: AxiosInstance = axios.create({
  baseURL: REPORTS_API_URL,
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
    const isAuthEndpoint = reqUrl.includes('/uat/sso/oauth/token');

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

      const sso = await callSso({
        grant_type: 'refresh_token',
        refresh_token: currentTokens.refreshToken,
      });
      const newTokens: AuthTokens = {
        accessToken: sso.access_token,
        refreshToken: sso.refresh_token,
        expiresAt: Date.now() + sso.expires_in * 1000,
      };

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
  login: async (username: string, password: string): Promise<LoginResponse> => {
    try {
      const sso = await callSso({ grant_type: 'password', username, password });
      const tokens: AuthTokens = {
        accessToken: sso.access_token,
        refreshToken: sso.refresh_token,
        expiresAt: Date.now() + sso.expires_in * 1000,
      };
      const user = await fetchRpUser(sso.access_token);
      return { user, tokens, sessionId: sso.jti };
    } catch (err) {
      throw new Error(extractErrorMessage(err, 'Login failed. Please try again.'));
    }
  },

  logout: async (): Promise<void> => {
    // ReportPortal SSO has no server-side logout — local state is cleared by the caller
  },

  refreshToken: async (token: string): Promise<AuthTokens> => {
    const sso = await callSso({ grant_type: 'refresh_token', refresh_token: token });
    return {
      accessToken: sso.access_token,
      refreshToken: sso.refresh_token,
      expiresAt: Date.now() + sso.expires_in * 1000,
    };
  },

  getMe: async (): Promise<User> => {
    const res = await apiClient.get<RpUserResponse>('/users');
    const r = res.data;
    return {
      id: String(r.id),
      login: r.userId,
      email: r.email,
      name: r.fullName ?? r.userId,
      avatar: r.photoId ?? null,
      role: r.userRole,
      isActive: r.active,
      assignedProjects: r.assignedProjects,
    };
  },
};

// ─── Recordings API ───────────────────────────────────────────────────────────

export interface CreateRecordingPayload {
  title: string;
  type: BackendRecordingType;
  totalChunks: number;
  mimeType: string;
}

// Spring Page<T> shape returned by Java list endpoints
interface SpringPage<T> {
  content: T[];
  totalElements: number;
  number: number; // 0-indexed
  size: number;
  last: boolean;
}

export const recordingsApi = {
  create: async (payload: CreateRecordingPayload): Promise<Recording> => {
    const response = await apiClient.post<Recording>(
      `${REPORTS_API_URL}/v1/${PROJECT}/records`,
      payload,
    );
    return response.data;
  },

  list: async (page = 1, limit = 20, type?: string): Promise<PaginatedResponse<Recording>> => {
    const params = new URLSearchParams({
      page: String(page - 1), // Spring is 0-indexed
      size: String(limit),
      ...(type ? { type } : {}),
    });
    const response = await apiClient.get<SpringPage<Recording>>(
      `${REPORTS_API_URL}/v1/${PROJECT}/records?${params}`,
    );
    return {
      data: response.data.content,
      total: response.data.totalElements,
      page: response.data.number + 1,
      limit: response.data.size,
      hasMore: !response.data.last,
    };
  },

  get: async (id: string): Promise<Recording> => {
    const response = await apiClient.get<Recording>(
      `${REPORTS_API_URL}/v1/${PROJECT}/records/${id}`,
    );
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`${REPORTS_API_URL}/v1/${PROJECT}/records/${id}`);
  },

  updateTitle: async (id: string, title: string): Promise<Recording> => {
    const response = await apiClient.patch<Recording>(
      `${REPORTS_API_URL}/v1/${PROJECT}/records/${id}`,
      { title },
    );
    return response.data;
  },

  search: async (query: string): Promise<Recording[]> => {
    const response = await apiClient.get<SpringPage<Recording>>(
      `${REPORTS_API_URL}/v1/${PROJECT}/records?search=${encodeURIComponent(query)}`,
    );
    return response.data.content;
  },
};

// ─── Upload API ───────────────────────────────────────────────────────────────
// Backend endpoints:
//   POST   /uploads/initiate    body: { recordingId, totalChunks, mimeType }
//   POST   /uploads/chunk       query: { recordingId, chunkIndex, totalChunks }  multipart
//   POST   /uploads/complete/:recordingId
//   DELETE /uploads/abort/:recordingId

export const uploadApi = {
  initUpload: async (metadata: RecordingMetadata): Promise<InitUploadResponse> => {
    const payload = metadata as RecordingMetadata & { totalChunks?: number };
    const resolvedChunks = payload.totalChunks ?? 1;

    const recording = await recordingsApi.create({
      title: metadata.title,
      type: toBackendRecordingType(metadata.type),
      totalChunks: resolvedChunks,
      mimeType: metadata.mimeType,
    });

    await apiClient.post(`${REPORTS_API_URL}/v1/${PROJECT}/uploads/initiate`, {
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

    const response = await apiClient.post<ChunkUploadResponse>(
      `${REPORTS_API_URL}/v1/${PROJECT}/uploads/chunk?recordingId=${encodeURIComponent(recordingId)}&chunkIndex=${chunkIndex}&totalChunks=${totalChunks}`,
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
    return response.data;
  },

  finalizeUpload: async (recordingId: string): Promise<FinalizeUploadResponse> => {
    const response = await apiClient.post<FinalizeUploadResponse>(
      `${REPORTS_API_URL}/v1/${PROJECT}/uploads/complete/${encodeURIComponent(recordingId)}`,
    );
    return response.data;
  },

  cancelUpload: async (recordingId: string): Promise<void> => {
    await apiClient.delete(
      `${REPORTS_API_URL}/v1/${PROJECT}/uploads/abort/${encodeURIComponent(recordingId)}`,
    );
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

export default apiClient;
