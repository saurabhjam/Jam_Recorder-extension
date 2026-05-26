/// <reference types="vite/client" />

import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type {
  ApiResponse,
  PaginatedResponse,
  LoginRequest,
  AuthTokens,
  User,
  Recording,
  RecordingWithUser,
  RecordingQuery,
  UpdateRecordingRequest,
  Team,
  TeamMember,
  TeamInvite,
  InviteMemberRequest,
  UpdateMemberRoleRequest,
  RecordingAnalytics,
  Comment,
  CreateCommentRequest,
  Notification,
  ShareLink,
  CreateShareLinkRequest,
} from '@snaptrace/types';
const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) || 'http://localhost:3000/api';

class ApiService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30_000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Request interceptor — attach JWT
    this.client.interceptors.request.use(
      (config) => {
        const token = this.getAccessToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => Promise.reject(error),
    );

    // Response interceptor — handle 401 with token refresh
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config as AxiosRequestConfig & { _retry?: boolean };

        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;
          try {
            const refreshToken = this.getRefreshToken();
            if (refreshToken) {
              const { data } = await axios.post<{
                success: boolean;
                data: { tokens: { accessToken: string; refreshToken: string; expiresAt: number } };
              }>(`${API_BASE_URL}/auth/refresh`, { refreshToken });
              const t = data.data?.tokens;
              if (t?.accessToken) {
                const newTokens: AuthTokens = {
                  accessToken: t.accessToken,
                  refreshToken: t.refreshToken ?? refreshToken,
                  expiresIn: Math.floor((t.expiresAt - Date.now()) / 1000),
                };
                this.setTokens(newTokens);
                if (originalRequest.headers) {
                  originalRequest.headers.Authorization = `Bearer ${newTokens.accessToken}`;
                }
                return this.client(originalRequest);
              }
            }
          } catch {
            this.clearTokens();
            window.location.href = '/login';
          }
        }

        const message =
          error.response?.data?.message ??
          error.response?.data?.error ??
          error.message ??
          'An unexpected error occurred';
        return Promise.reject(new Error(message));
      },
    );
  }

  // ─── Token helpers ────────────────────────────────────────────────────────

  getAccessToken(): string | null {
    return localStorage.getItem('snaptrace_access_token');
  }

  getRefreshToken(): string | null {
    return localStorage.getItem('snaptrace_refresh_token');
  }

  setTokens(tokens: AuthTokens): void {
    localStorage.setItem('snaptrace_access_token', tokens.accessToken);
    localStorage.setItem('snaptrace_refresh_token', tokens.refreshToken);
  }

  clearTokens(): void {
    localStorage.removeItem('snaptrace_access_token');
    localStorage.removeItem('snaptrace_refresh_token');
    localStorage.removeItem('snaptrace_user');
  }

  // ─── Generic request helpers ──────────────────────────────────────────────

  private async get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
    const { data } = await this.client.get<ApiResponse<T>>(url, { params });
    return data.data as T;
  }

  private async post<T>(url: string, body?: unknown): Promise<T> {
    const { data } = await this.client.post<ApiResponse<T>>(url, body);
    return data.data as T;
  }

  private async patch<T>(url: string, body?: unknown): Promise<T> {
    const { data } = await this.client.patch<ApiResponse<T>>(url, body);
    return data.data as T;
  }

  private async delete<T>(url: string): Promise<T> {
    const { data } = await this.client.delete<ApiResponse<T>>(url);
    return data.data as T;
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  async login(body: LoginRequest): Promise<{ user: User; tokens: AuthTokens }> {
    const raw = await this.post<{
      user: User;
      tokens: { accessToken: string; refreshToken: string; expiresAt: number };
      sessionId: string;
    }>('/auth/login', body);
    const tokens: AuthTokens = {
      accessToken: raw.tokens.accessToken,
      refreshToken: raw.tokens.refreshToken,
      expiresIn: Math.floor((raw.tokens.expiresAt - Date.now()) / 1000),
    };
    this.setTokens(tokens);
    return { user: raw.user, tokens };
  }

  async register(body: {
    name: string;
    email: string;
    password: string;
  }): Promise<{ user: User; tokens: AuthTokens }> {
    const raw = await this.post<{
      user: User;
      tokens: { accessToken: string; refreshToken: string; expiresAt: number };
      sessionId: string;
    }>('/auth/register', body);
    const tokens: AuthTokens = {
      accessToken: raw.tokens.accessToken,
      refreshToken: raw.tokens.refreshToken,
      expiresIn: Math.floor((raw.tokens.expiresAt - Date.now()) / 1000),
    };
    this.setTokens(tokens);
    return { user: raw.user, tokens };
  }

  async logout(): Promise<void> {
    try {
      await this.post('/auth/logout');
    } finally {
      this.clearTokens();
    }
  }

  async getMe(): Promise<User> {
    return this.get<User>('/auth/me');
  }

  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    const raw = await this.post<{
      tokens: { accessToken: string; refreshToken: string; expiresAt: number };
    }>('/auth/refresh', { refreshToken });
    const tokens: AuthTokens = {
      accessToken: raw.tokens.accessToken,
      refreshToken: raw.tokens.refreshToken ?? refreshToken,
      expiresIn: Math.floor((raw.tokens.expiresAt - Date.now()) / 1000),
    };
    this.setTokens(tokens);
    return tokens;
  }

  async updateProfile(body: { name?: string; avatar?: string }): Promise<User> {
    return this.patch<User>('/auth/me', body);
  }

  async changePassword(body: { currentPassword: string; newPassword: string }): Promise<void> {
    await this.post('/auth/change-password', body);
  }

  async deleteAccount(): Promise<void> {
    await this.delete('/auth/account');
    this.clearTokens();
  }

  async forgotPassword(email: string): Promise<void> {
    await this.post('/auth/forgot-password', { email });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    await this.post('/auth/reset-password', { token, newPassword });
  }

  // ─── Recordings ───────────────────────────────────────────────────────────

  async getRecordings(query?: RecordingQuery): Promise<PaginatedResponse<Recording>> {
    const { data } = await this.client.get<PaginatedResponse<Recording>>('/recordings', {
      params: query,
    });
    return data;
  }

  async getRecording(id: string): Promise<Recording> {
    return this.get<Recording>(`/recordings/${id}`);
  }

  async getRecordingByShareId(shareId: string): Promise<RecordingWithUser> {
    return this.get<RecordingWithUser>(`/recordings/share/${shareId}`);
  }

  async updateRecording(id: string, body: UpdateRecordingRequest): Promise<Recording> {
    return this.patch<Recording>(`/recordings/${id}`, body);
  }

  async deleteRecording(id: string): Promise<void> {
    await this.delete(`/recordings/${id}`);
  }

  async incrementView(id: string): Promise<void> {
    await this.post(`/recordings/${id}/view`);
  }

  async getShareLink(recordingId: string): Promise<ShareLink> {
    return this.get<ShareLink>(`/recordings/${recordingId}/share`);
  }

  async createShareLink(body: CreateShareLinkRequest): Promise<ShareLink> {
    return this.post<ShareLink>('/shares', body);
  }

  async downloadRecording(id: string): Promise<Blob> {
    const response: AxiosResponse<Blob> = await this.client.get(`/recordings/${id}/download`, {
      responseType: 'blob',
    });
    return response.data;
  }

  // ─── Analytics ────────────────────────────────────────────────────────────

  async getDashboardStats(): Promise<{
    totalRecordings: number;
    totalViews: number;
    storageUsed: number;
    teamMembers: number;
    recordingsChange: number;
    viewsChange: number;
    storageChange: number;
  }> {
    return this.get('/analytics/dashboard');
  }

  async getRecordingAnalytics(
    recordingId: string,
    range: '7d' | '30d' | '90d' = '30d',
  ): Promise<RecordingAnalytics> {
    return this.get<RecordingAnalytics>(`/analytics/recordings/${recordingId}`, { range });
  }

  async getOverviewAnalytics(range: '7d' | '30d' | '90d' = '30d'): Promise<{
    viewsByDay: Array<{ date: string; views: number; plays: number }>;
    topRecordings: Array<{ id: string; title: string; views: number }>;
    sources: Array<{ name: string; value: number }>;
    geography: Array<{ country: string; views: number; percentage: number }>;
    totalPlays: number;
    uniqueViewers: number;
    avgWatchTime: number;
    completionRate: number;
  }> {
    return this.get('/analytics/overview', { range });
  }

  async getActivityFeed(): Promise<
    Array<{
      id: string;
      type: string;
      message: string;
      metadata?: Record<string, unknown>;
      createdAt: string;
    }>
  > {
    return this.get('/analytics/activity');
  }

  // ─── Team ─────────────────────────────────────────────────────────────────

  async getTeam(): Promise<Team> {
    return this.get<Team>('/teams');
  }

  async getTeamMembers(): Promise<TeamMember[]> {
    return this.get<TeamMember[]>('/teams/members');
  }

  async inviteMember(body: InviteMemberRequest): Promise<TeamInvite> {
    return this.post<TeamInvite>('/teams/invite', body);
  }

  async updateMemberRole(userId: string, body: UpdateMemberRoleRequest): Promise<TeamMember> {
    return this.patch<TeamMember>(`/teams/members/${userId}/role`, body);
  }

  async removeMember(userId: string): Promise<void> {
    await this.delete(`/teams/members/${userId}`);
  }

  async getPendingInvites(): Promise<TeamInvite[]> {
    return this.get<TeamInvite[]>('/teams/invites');
  }

  async cancelInvite(inviteId: string): Promise<void> {
    await this.delete(`/teams/invites/${inviteId}`);
  }

  // ─── Comments ─────────────────────────────────────────────────────────────

  async getComments(recordingId: string): Promise<Comment[]> {
    return this.get<Comment[]>(`/recordings/${recordingId}/comments`);
  }

  async createComment(recordingId: string, body: CreateCommentRequest): Promise<Comment> {
    return this.post<Comment>(`/recordings/${recordingId}/comments`, body);
  }

  async deleteComment(recordingId: string, commentId: string): Promise<void> {
    await this.delete(`/recordings/${recordingId}/comments/${commentId}`);
  }

  // ─── Reactions ────────────────────────────────────────────────────────────

  async getReactions(
    recordingId: string,
  ): Promise<{ counts: Record<string, number>; mine: string[] }> {
    return this.get(`/recordings/${recordingId}/reactions`);
  }

  async toggleReaction(
    recordingId: string,
    emoji: string,
  ): Promise<{ counts: Record<string, number>; mine: string[] }> {
    return this.post(`/recordings/${recordingId}/reactions`, { emoji });
  }

  // ─── Notifications ────────────────────────────────────────────────────────

  async getNotifications(): Promise<Notification[]> {
    return this.get<Notification[]>('/notifications');
  }

  async markNotificationRead(id: string): Promise<void> {
    await this.patch(`/notifications/${id}/read`);
  }

  async markAllNotificationsRead(): Promise<void> {
    await this.post('/notifications/read-all');
  }

  // ─── Avatar upload ────────────────────────────────────────────────────────

  async uploadAvatar(file: File): Promise<{ url: string }> {
    const form = new FormData();
    form.append('avatar', file);
    const { data } = await this.client.post<ApiResponse<{ url: string }>>('/auth/avatar', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data.data as { url: string };
  }
}

export const api = new ApiService();
export default api;
