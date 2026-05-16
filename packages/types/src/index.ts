// ============================================================
// User & Auth Types
// ============================================================

export type UserRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface User {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
  role?: UserRole;
  teamId: string | null;
  isVerified: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicUser {
  id: string;
  name: string;
  avatar: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface UpdateProfileRequest {
  name?: string;
  avatar?: string;
}

export interface AuthState {
  user: User | null;
  tokens: AuthTokens | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

// ============================================================
// Recording Types
// ============================================================

export type RecordingStatus = 'recording' | 'processing' | 'ready' | 'failed' | 'uploading';

export type RecordingStatusDB = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';

export type RecordingType = 'screen' | 'tab' | 'webcam' | 'screenshot';

export type RecordingTypeDB = 'SCREEN' | 'TAB' | 'WEBCAM' | 'SCREENSHOT';

export interface ConsoleLogs {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  message: string;
  timestamp: number;
  source?: string;
}

export interface NetworkLog {
  method: string;
  url: string;
  status: number;
  duration: number;
  size: number;
  timestamp: number;
  type: string;
}

export interface DeviceInfo {
  type: 'desktop' | 'mobile' | 'tablet';
  brand?: string;
  model?: string;
}

export interface RecordingMetadata {
  browser?: string;
  browserVersion?: string;
  os?: string;
  osVersion?: string;
  screenResolution?: string;
  fps?: number;
  consoleLogs?: ConsoleLogs[];
  networkLogs?: NetworkLog[];
  deviceInfo?: DeviceInfo;
  url?: string;
  tabTitle?: string;
}

export interface Recording {
  id: string;
  userId: string;
  teamId: string | null;
  title: string;
  description: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  duration: number | null;
  size: number | null;
  mimeType: string | null;
  status: RecordingStatusDB;
  type: RecordingTypeDB;
  metadata: RecordingMetadata | null;
  shareId: string;
  isPublic: boolean;
  allowDownload: boolean;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecordingWithUser extends Recording {
  user: PublicUser;
}

export interface CreateRecordingRequest {
  title?: string;
  description?: string;
  type: RecordingTypeDB;
  totalChunks: number;
  mimeType?: string;
  metadata?: RecordingMetadata;
}

export interface UpdateRecordingRequest {
  title?: string;
  description?: string;
  isPublic?: boolean;
  allowDownload?: boolean;
}

export interface RecordingQuery {
  page?: number;
  limit?: number;
  status?: RecordingStatusDB;
  type?: RecordingTypeDB;
  search?: string;
  sortBy?: 'createdAt' | 'updatedAt' | 'viewCount' | 'duration';
  sortOrder?: 'asc' | 'desc';
}

// ============================================================
// Recording State (for Chrome Extension / Frontend)
// ============================================================

export interface RecordingState {
  isRecording: boolean;
  isPaused: boolean;
  recordingType: RecordingType;
  duration: number;
  stream?: unknown; // MediaStream — browser-only, typed as unknown for Node.js compatibility
  chunks: Blob[];
  recordingId?: string;
  startTime?: number;
}

// ============================================================
// Upload Types
// ============================================================

export interface UploadChunk {
  id: string;
  recordingId: string;
  chunkIndex: number;
  totalChunks: number;
  size: number;
  checksum: string | null;
  cloudUrl: string | null;
  uploadedAt: Date;
}

export interface UploadProgress {
  recordingId: string;
  progress: number;
  uploadedChunks: number;
  totalChunks: number;
  speed: number;
  eta: number;
  status: RecordingStatusDB;
}

export interface InitiateUploadRequest {
  recordingId: string;
  totalChunks: number;
  mimeType: string;
}

export interface UploadChunkRequest {
  recordingId: string;
  chunkIndex: number;
  totalChunks: number;
  checksum?: string;
}

// ============================================================
// Team Types
// ============================================================

export type TeamPlan = 'FREE' | 'PRO' | 'TEAM' | 'ENTERPRISE';

export interface Team {
  id: string;
  name: string;
  slug: string;
  plan: TeamPlan;
  logo: string | null;
  membersCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamMember {
  userId: string;
  teamId: string;
  role: UserRole;
  joinedAt: Date;
  user?: PublicUser;
}

export interface CreateTeamRequest {
  name: string;
  slug?: string;
}

export interface InviteMemberRequest {
  email: string;
  role?: UserRole;
}

export interface AcceptInviteRequest {
  token: string;
}

export interface UpdateMemberRoleRequest {
  role: UserRole;
}

export interface TeamInvite {
  id: string;
  teamId: string;
  email: string;
  role: UserRole;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

// ============================================================
// Share Types
// ============================================================

export interface ShareLink {
  id: string;
  recordingId: string;
  token: string;
  expiresAt: Date | null;
  viewCount: number;
  isPasswordProtected: boolean;
  allowDownload: boolean;
  createdAt: Date;
}

export interface CreateShareLinkRequest {
  recordingId: string;
  expiresAt?: Date;
  password?: string;
  allowDownload?: boolean;
}

export interface AccessShareRequest {
  token: string;
  password?: string;
}

// ============================================================
// Analytics Types
// ============================================================

export type AnalyticsEventType =
  | 'view'
  | 'play'
  | 'pause'
  | 'seek'
  | 'complete'
  | 'download'
  | 'share'
  | 'comment';

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  recordingId: string;
  userId?: string;
  visitorId?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface RecordingAnalytics {
  recordingId: string;
  totalViews: number;
  uniqueVisitors: number;
  avgWatchTime: number;
  completionRate: number;
  topReferrers: Array<{ referer: string; count: number }>;
  viewsByDay: Array<{ date: string; count: number }>;
}

// ============================================================
// Comment Types
// ============================================================

export interface Comment {
  id: string;
  recordingId: string;
  userId: string;
  content: string;
  timestamp: number | null;
  parentId: string | null;
  replies?: Comment[];
  user?: PublicUser;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCommentRequest {
  content: string;
  timestamp?: number;
  parentId?: string;
}

export interface UpdateCommentRequest {
  content: string;
}

// ============================================================
// Notification Types
// ============================================================

export type NotificationType = 'RECORDING_READY' | 'COMMENT' | 'TEAM_INVITE' | 'SHARE_VIEWED';

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

// ============================================================
// API Response Types
// ============================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends Omit<ApiResponse<T[]>, 'data'> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface ApiError {
  success: false;
  error: string;
  message?: string;
  statusCode?: number;
  details?: unknown;
}

// ============================================================
// Extension Message Types
// ============================================================

export type ExtensionMessageType =
  | 'START_RECORDING'
  | 'STOP_RECORDING'
  | 'PAUSE_RECORDING'
  | 'RESUME_RECORDING'
  | 'TAKE_SCREENSHOT'
  | 'UPLOAD_CHUNK'
  | 'UPLOAD_COMPLETE'
  | 'GET_RECORDING_STATE'
  | 'AUTH_STATE_CHANGED'
  | 'RECORDING_UPLOADED'
  | 'ERROR';

export interface ExtensionMessage {
  type: ExtensionMessageType;
  payload?: Record<string, unknown>;
}

export interface StartRecordingPayload {
  type: RecordingType;
  title?: string;
  includeAudio?: boolean;
  includeCamera?: boolean;
}

export interface StopRecordingPayload {
  recordingId?: string;
}

export interface UploadChunkPayload {
  recordingId: string;
  chunkIndex: number;
  totalChunks: number;
  data: ArrayBuffer;
  checksum?: string;
}

// ============================================================
// Socket Event Types
// ============================================================

export type SocketEventType =
  | 'recording:progress'
  | 'recording:ready'
  | 'recording:failed'
  | 'upload:progress'
  | 'notification:new'
  | 'comment:new'
  | 'room:join'
  | 'room:leave';

export interface SocketEvent {
  type: SocketEventType;
  payload: Record<string, unknown>;
}

// ============================================================
// Queue Job Types
// ============================================================

export interface VideoProcessingJob {
  recordingId: string;
  userId: string;
  mimeType: string;
  totalChunks: number;
}

export interface ThumbnailJob {
  recordingId: string;
  videoUrl: string;
  timestamp?: number;
}

export interface NotificationJob {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface AnalyticsJob {
  event: AnalyticsEventType;
  recordingId: string;
  userId?: string;
  visitorId?: string;
  ip?: string;
  userAgent?: string;
  referer?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================
// Storage Types
// ============================================================

export interface UploadOptions {
  folder?: string;
  publicId?: string;
  resourceType?: 'image' | 'video' | 'raw' | 'auto';
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface UploadResult {
  publicId: string;
  url: string;
  secureUrl: string;
  size: number;
  format: string;
  duration?: number;
  width?: number;
  height?: number;
}

export interface TransformOptions {
  width?: number;
  height?: number;
  quality?: number;
  format?: string;
  crop?: string;
}
