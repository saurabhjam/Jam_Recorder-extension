// ─── Auth Types ────────────────────────────────────────────────────────────────

/** Project assigned to a user. */
export interface AssignedProject {
  projectId: number;
  projectRole: string;
  entryType: 'INTERNAL' | 'PERSONAL';
}

/** User shape — mapped from ReportPortal's UserResource. */
export interface User {
  id: string;
  login: string;
  email: string;
  name: string;
  avatar: string | null;
  role: string;
  isActive: boolean;
  // Assigned projects mapping: projectName -> projectDetails
  assignedProjects?: Record<string, AssignedProject>;
  // Legacy fields kept optional so existing storage reads don't break
  teamId?: string | null;
  isVerified?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Token pair stored in chrome.storage.local.
 * expiresAt is a Unix timestamp in milliseconds (Date.now() style).
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Bearer token for direct calls to the external ReportPortal API. */
  externalToken?: string;
  externalTokenExpiresAt?: number;
}

export interface LoginResponse {
  user: User;
  tokens: AuthTokens;
  sessionId: string;
}

// ─── Recording Types ───────────────────────────────────────────────────────────

/** Values the extension uses internally (lowercase). */
export type RecordingType = 'screen' | 'tab' | 'webcam' | 'screenshot';

/**
 * Values the backend schema expects (uppercase).
 * Used when creating/querying recordings via the API.
 */
export type BackendRecordingType = 'SCREEN' | 'TAB' | 'WEBCAM' | 'SCREENSHOT';

export function toBackendRecordingType(type: RecordingType): BackendRecordingType {
  return type.toUpperCase() as BackendRecordingType;
}

export type RecordingStatus =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'uploading'
  | 'done'
  | 'error';

/** Recording resolution. Capped at 1080p; 720p is the size-optimized default. */
export type RecordingQuality = '480p' | '720p' | '1080p';

export interface RecordingOptions {
  type: RecordingType;
  quality: RecordingQuality;
  micEnabled: boolean;
  webcamOverlay: boolean;
  systemAudio: boolean;
  /** Capture console + network logs (DevTools) alongside the video. */
  captureDevtools?: boolean;
  tabId?: number;
}

export interface Recording {
  id: string;
  title: string;
  type: BackendRecordingType;
  duration: number;
  fileSize: number;
  thumbnailUrl?: string;
  shareUrl?: string;
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';
  createdAt: string;
  updatedAt: string;
  views: number;
  userId: string;
}

/**
 * A local, pre-upload recording tracked in the Drafts tab so an accidentally
 * closed or not-yet-saved recording can always be recovered. Kept in
 * `chrome.storage.local[STORAGE_KEYS.DRAFTS_INDEX]`, newest first, capped at 5.
 * Registered as soon as the recording finishes (independent of whether the
 * editor window is ever opened/closed), then promoted to `status: 'saved'`
 * once the editor uploads it — it stays in the list either way.
 */
export interface DraftRecording {
  recordingId: string;
  title: string;
  thumbnailDataUrl: string | null;
  duration: number;
  blobSize: number;
  recordingType: string;
  createdAt: number;
  status: 'draft' | 'saved';
  backendRecordId?: string;
  shareUrl?: string;
  videoUrl?: string;
}

// ─── Upload Types ──────────────────────────────────────────────────────────────

export interface UploadProgress {
  recordingId: string;
  totalChunks: number;
  uploadedChunks: number;
  totalBytes: number;
  uploadedBytes: number;
  speed: number;
  percentComplete: number;
  eta: number;
}

export interface RecordingMetadata {
  title: string;
  /** User-provided description; capped at 125 chars at the input and again before upload. */
  description?: string;
  type: RecordingType;
  duration: number;
  mimeType: string;
  quality: RecordingQuality;
  hasAudio: boolean;
  hasWebcam: boolean;
}

export interface InitUploadResponse {
  recordingId: string;
}

export interface ChunkUploadResponse {
  chunkIndex: number;
  received: boolean;
}

export interface FinalizeUploadResponse {
  recordingId: string;
  shareUrl: string;
  status: 'PROCESSING' | 'READY';
}

// ─── Message Types ─────────────────────────────────────────────────────────────

export type ScreenshotCaptureType = 'full-page' | 'area' | 'visible';

export type MessageType =
  | 'START_RECORDING'
  | 'STOP_RECORDING'
  | 'PAUSE_RECORDING'
  | 'RESUME_RECORDING'
  | 'SET_MIC_MUTED'
  | 'TAKE_SCREENSHOT'
  | 'RECORDING_STARTED'
  | 'RECORDING_STOPPED'
  | 'RECORDING_ERROR'
  | 'UPLOAD_PROGRESS'
  | 'UPLOAD_COMPLETE'
  | 'SHOW_TOOLBAR'
  | 'HIDE_TOOLBAR'
  | 'ENSURE_TOOLBAR'
  | 'SHOW_COUNTDOWN'
  | 'UPDATE_TIMER'
  | 'RECORDING_PAUSE_STATE'
  | 'GET_STATE'
  | 'STATE_RESPONSE'
  | 'OPEN_POPUP'
  | 'AUTH_STATE_CHANGED'
  | 'TOKEN_REFRESHED'
  | 'START_GOOGLE_LOGIN'
  | 'OAUTH_LOGIN_COMPLETE'
  | 'CAPTURE_FLUSH'
  // Screenshot workflow messages (background ↔ content script)
  | 'SCREENSHOT_GET_DIMENSIONS'
  | 'SCREENSHOT_SCROLL_TO'
  | 'SCREENSHOT_RESTORE_SCROLL'
  | 'SCREENSHOT_SHOW_SELECTOR'
  | 'SCREENSHOT_SHOW_PREVIEW'
  | 'SCREENSHOT_AREA_SELECTED'
  | 'SCREENSHOT_PREPARE_CAPTURE'
  | 'SCREENSHOT_SET_FRAME'
  | 'SCREENSHOT_RESTORE_CAPTURE';

// ─── Capture Types ─────────────────────────────────────────────────────────────

export type CaptureLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface CaptureConsoleLog {
  level: CaptureLevel;
  message: string;
  timestamp: number;
  url: string;
  source: 'cdp' | 'injected';
}

export interface CaptureNetworkEntry {
  id: string;
  url: string;
  method: string;
  status: number;
  statusText: string;
  duration: number;
  timestamp: number;
  size: number;
  mimeType?: string;
  initiator?: string;
  failed?: boolean;
  errorText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  responseBodyTruncated?: boolean;
  source: 'cdp' | 'injected';
}

export interface CaptureData {
  consoleLogs: CaptureConsoleLog[];
  networkCaptures: CaptureNetworkEntry[];
}

export type OffscreenMessageType =
  | 'OFFSCREEN_START_RECORDING'
  | 'OFFSCREEN_STOP_RECORDING'
  | 'OFFSCREEN_PAUSE_RECORDING'
  | 'OFFSCREEN_RESUME_RECORDING'
  | 'OFFSCREEN_SET_MIC_MUTED'
  | 'OFFSCREEN_MIC_UNAVAILABLE'
  | 'OFFSCREEN_TAKE_SCREENSHOT'
  | 'OFFSCREEN_RECORDING_STARTED'
  | 'OFFSCREEN_RECORDING_STOPPED'
  | 'OFFSCREEN_UPLOAD_PROGRESS'
  | 'OFFSCREEN_UPLOAD_COMPLETE'
  | 'OFFSCREEN_ERROR'
  | 'OFFSCREEN_RECORDING_READY';

export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  target?: 'background' | 'offscreen';
  payload?: T;
  error?: string;
}

export interface OffscreenMessage<T = unknown> {
  type: OffscreenMessageType;
  target: 'offscreen' | 'background';
  payload?: T;
  error?: string;
}

// ─── Settings Types ────────────────────────────────────────────────────────────

export interface ExtensionSettings {
  micEnabled: boolean;
  /**
   * Whether the user has actually granted microphone access to the extension.
   * Set once the dedicated permission page's getUserMedia succeeds — this is the
   * source of truth for "can we record with mic", because
   * `navigator.permissions.query` is unreliable in the action popup and would
   * otherwise send the user back to the permission page in a loop.
   */
  micPermissionGranted?: boolean;
  webcamOverlay: boolean;
  webcamPosition: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  recordingQuality: RecordingQuality;
  systemAudio: boolean;
  /** Capture console + network logs (DevTools) alongside recordings. */
  captureDevtools: boolean;
  countdownEnabled: boolean;
  countdownSeconds: number;
  autoOpenShare: boolean;
  hotkeys: {
    startRecording: string;
    stopRecording: string;
    takeScreenshot: string;
  };
  theme: 'dark' | 'light' | 'system';
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  micEnabled: true,
  webcamOverlay: false,
  webcamPosition: 'bottom-right',
  // 720p @ 10fps (~146 MB/hr) — the size-optimized default; users can drop to
  // 480p for smaller files or raise to 1080p for max clarity.
  recordingQuality: '720p',
  systemAudio: false,
  captureDevtools: true,
  countdownEnabled: false,
  countdownSeconds: 3,
  autoOpenShare: true,
  hotkeys: {
    startRecording: 'Ctrl+Shift+R',
    stopRecording: 'Ctrl+Shift+S',
    takeScreenshot: 'Ctrl+Shift+X',
  },
  theme: 'dark',
};

// ─── API Response Types ────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  message?: string;
  success: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

// ─── Annotation Types ──────────────────────────────────────────────────────────

export type AnnotationTool =
  | 'select'
  | 'pen'
  | 'arrow'
  | 'rectangle'
  | 'circle'
  | 'text'
  | 'highlight'
  | 'blur'
  | 'eraser';

export interface AnnotationColor {
  name: string;
  value: string;
}

export const ANNOTATION_COLORS: AnnotationColor[] = [
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#8b5cf6' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'White', value: '#f8fafc' },
  { name: 'Black', value: '#0f172a' },
];

// ─── Storage Keys ──────────────────────────────────────────────────────────────

export const STORAGE_KEYS = {
  AUTH_USER: 'st_auth_user',
  AUTH_TOKENS: 'st_auth_tokens',
  AUTH_SESSION_ID: 'st_auth_session_id',
  AUTH_PROJECT: 'st_auth_project',
  // Locally-edited profile fields (name/avatar), keyed by user login, re-applied
  // on top of the server user at every login so edits survive re-login.
  AUTH_PROFILE_OVERRIDES: 'st_profile_overrides',
  SETTINGS: 'st_settings',
  RECORDING_STATE: 'st_recording_state',
  OFFLINE_QUEUE: 'st_offline_queue',
  PENDING_SHARE: 'st_pending_share',
  EDITOR_DATA: 'st_editor_data',
  DRAFTS_INDEX: 'st_drafts_index',
  PENDING_BLOB_CLEANUP: 'st_pending_blob_cleanup',
} as const;

/** chrome.alarms name for the token refresh alarm. */
export const AUTH_REFRESH_ALARM = 'st_token_refresh';

// ─── Quality Presets ───────────────────────────────────────────────────────────

export const QUALITY_PRESETS: Record<
  RecordingQuality,
  { width: number; height: number; frameRate: number; videoBitrate: number; audioBitrate: number }
> = {
  // Tuned for long-duration SCREEN recordings (meetings, dashboards, code), which
  // are mostly static — a low frame rate keeps on-screen text crisp at a fraction
  // of the bitrate, so multi-hour captures stay small enough to upload reliably.
  // Resolution is the user-facing knob (see the popup dropdown); each tier also
  // dials frame rate + bitrate so lower resolutions shrink the file further.
  // Approx output size per hour (video + audio, VP9):
  '480p': { width: 854, height: 480, frameRate: 10, videoBitrate: 150_000, audioBitrate: 24_000 }, // ~78 MB/hr — smallest
  '720p': { width: 1280, height: 720, frameRate: 10, videoBitrate: 300_000, audioBitrate: 24_000 }, // ~146 MB/hr — recommended (default)
  '1080p': {
    width: 1920,
    height: 1080,
    frameRate: 12,
    videoBitrate: 600_000,
    audioBitrate: 24_000,
  }, // ~281 MB/hr — best clarity
};
