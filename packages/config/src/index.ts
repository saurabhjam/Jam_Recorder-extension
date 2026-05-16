// ============================================================
// Shared SnapTrace Platform Configuration Constants
// ============================================================

// API Configuration
export const API_VERSION = 'v1';
export const API_BASE_PATH = `/api/${API_VERSION}`;

// API Endpoints
export const API_ENDPOINTS = {
  auth: {
    register: `${API_BASE_PATH}/auth/register`,
    login: `${API_BASE_PATH}/auth/login`,
    logout: `${API_BASE_PATH}/auth/logout`,
    refresh: `${API_BASE_PATH}/auth/refresh`,
    me: `${API_BASE_PATH}/auth/me`,
  },
  recordings: {
    list: `${API_BASE_PATH}/recordings`,
    create: `${API_BASE_PATH}/recordings`,
    get: (id: string) => `${API_BASE_PATH}/recordings/${id}`,
    update: (id: string) => `${API_BASE_PATH}/recordings/${id}`,
    delete: (id: string) => `${API_BASE_PATH}/recordings/${id}`,
    public: (shareId: string) => `${API_BASE_PATH}/recordings/public/${shareId}`,
    view: (id: string) => `${API_BASE_PATH}/recordings/${id}/view`,
    analytics: (id: string) => `${API_BASE_PATH}/recordings/${id}/analytics`,
    comments: (id: string) => `${API_BASE_PATH}/recordings/${id}/comments`,
  },
  uploads: {
    initiate: `${API_BASE_PATH}/uploads/initiate`,
    chunk: `${API_BASE_PATH}/uploads/chunk`,
    progress: (recordingId: string) => `${API_BASE_PATH}/uploads/progress/${recordingId}`,
    complete: (recordingId: string) => `${API_BASE_PATH}/uploads/complete/${recordingId}`,
    abort: (recordingId: string) => `${API_BASE_PATH}/uploads/abort/${recordingId}`,
  },
  shares: {
    create: `${API_BASE_PATH}/shares`,
    get: (token: string) => `${API_BASE_PATH}/shares/${token}`,
    delete: (token: string) => `${API_BASE_PATH}/shares/${token}`,
  },
  teams: {
    create: `${API_BASE_PATH}/teams`,
    me: `${API_BASE_PATH}/teams/me`,
    invite: `${API_BASE_PATH}/teams/invite`,
    acceptInvite: `${API_BASE_PATH}/teams/invite/accept`,
    removeMember: (userId: string) => `${API_BASE_PATH}/teams/members/${userId}`,
    updateRole: (userId: string) => `${API_BASE_PATH}/teams/members/${userId}/role`,
  },
  notifications: {
    list: `${API_BASE_PATH}/notifications`,
    markRead: (id: string) => `${API_BASE_PATH}/notifications/${id}/read`,
    markAllRead: `${API_BASE_PATH}/notifications/read-all`,
  },
} as const;

// Recording Limits
export const RECORDING_LIMITS = {
  FREE: {
    maxDuration: 300, // 5 minutes in seconds
    maxStorage: 1 * 1024 * 1024 * 1024, // 1 GB
    maxRecordings: 25,
    maxTeamMembers: 1,
  },
  PRO: {
    maxDuration: 3600, // 1 hour in seconds
    maxStorage: 50 * 1024 * 1024 * 1024, // 50 GB
    maxRecordings: Infinity,
    maxTeamMembers: 1,
  },
  TEAM: {
    maxDuration: 7200, // 2 hours in seconds
    maxStorage: 200 * 1024 * 1024 * 1024, // 200 GB
    maxRecordings: Infinity,
    maxTeamMembers: 25,
  },
  ENTERPRISE: {
    maxDuration: Infinity,
    maxStorage: Infinity,
    maxRecordings: Infinity,
    maxTeamMembers: Infinity,
  },
} as const;

// Upload Configuration
export const UPLOAD_CONFIG = {
  CHUNK_SIZE: 5 * 1024 * 1024, // 5 MB per chunk
  MAX_CHUNK_SIZE: 10 * 1024 * 1024, // 10 MB max per chunk
  MAX_FILE_SIZE: 5 * 1024 * 1024 * 1024, // 5 GB max file size
  MAX_CONCURRENT_CHUNKS: 3,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000, // 1 second base delay
} as const;

// Supported Formats
export const SUPPORTED_FORMATS = {
  video: ['video/webm', 'video/mp4', 'video/ogg', 'video/avi', 'video/quicktime'],
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  audio: ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg'],
} as const;

// Recording FPS Options
export const FPS_OPTIONS = [15, 24, 30, 60] as const;
export const DEFAULT_FPS = 30;

// Token Configuration
export const TOKEN_CONFIG = {
  ACCESS_TOKEN_EXPIRES: '15m',
  REFRESH_TOKEN_EXPIRES: '7d',
  SHARE_TOKEN_LENGTH: 32,
  INVITE_TOKEN_LENGTH: 32,
  INVITE_EXPIRES_DAYS: 7,
} as const;

// Pagination Defaults
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

// Rate Limiting
export const RATE_LIMITS = {
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
  },
  api: {
    windowMs: 60 * 1000, // 1 minute
    max: 100,
  },
  upload: {
    windowMs: 60 * 1000, // 1 minute
    max: 60,
  },
} as const;

// Socket Events
export const SOCKET_EVENTS = {
  RECORDING_PROGRESS: 'recording:progress',
  RECORDING_READY: 'recording:ready',
  RECORDING_FAILED: 'recording:failed',
  UPLOAD_PROGRESS: 'upload:progress',
  NOTIFICATION_NEW: 'notification:new',
  COMMENT_NEW: 'comment:new',
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
} as const;

// Queue Names
export const QUEUE_NAMES = {
  VIDEO_PROCESSING: 'video-processing',
  THUMBNAIL_GENERATION: 'thumbnail-generation',
  ANALYTICS: 'analytics',
  NOTIFICATIONS: 'notifications',
  EMAIL: 'email',
} as const;

// Cache TTLs (in seconds)
export const CACHE_TTL = {
  RECORDING: 300, // 5 minutes
  USER: 600, // 10 minutes
  TEAM: 600, // 10 minutes
  ANALYTICS: 3600, // 1 hour
  SHARE_LINK: 60, // 1 minute
} as const;

// Error Codes
export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DUPLICATE_ERROR: 'DUPLICATE_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  UPLOAD_ERROR: 'UPLOAD_ERROR',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
  STORAGE_ERROR: 'STORAGE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

// HTTP Status Codes
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

// Cloudinary Folders
export const CLOUDINARY_FOLDERS = {
  RECORDINGS: 'snaptrace/recordings',
  THUMBNAILS: 'snaptrace/thumbnails',
  AVATARS: 'snaptrace/avatars',
  CHUNKS: 'snaptrace/chunks',
  TEAM_LOGOS: 'snaptrace/teams',
} as const;

// Feature Flags
export const FEATURE_FLAGS = {
  ENABLE_COMMENTS: true,
  ENABLE_ANALYTICS: true,
  ENABLE_TEAMS: true,
  ENABLE_DOWNLOADS: true,
  ENABLE_WEBCAM: true,
  ENABLE_SCREENSHOTS: true,
  ENABLE_CONSOLE_LOGS: true,
  ENABLE_NETWORK_LOGS: true,
} as const;
