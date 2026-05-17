import { z } from 'zod';

export const createRecordingSchema = z.object({
  title: z
    .string()
    .max(200, 'Title must not exceed 200 characters')
    .trim()
    .optional()
    .default('Untitled Recording'),
  description: z
    .string()
    .max(2000, 'Description must not exceed 2000 characters')
    .trim()
    .optional()
    .nullable(),
  type: z.enum(['SCREEN', 'TAB', 'WEBCAM', 'SCREENSHOT'], {
    required_error: 'Recording type is required',
  }),
  totalChunks: z
    .number({ required_error: 'Total chunks count is required' })
    .int('Total chunks must be an integer')
    .positive('Total chunks must be positive')
    .max(10000, 'Too many chunks'),
  mimeType: z.string().max(100).optional().default('video/webm'),
  metadata: z
    .object({
      browser: z.string().max(100).optional(),
      browserVersion: z.string().max(50).optional(),
      os: z.string().max(100).optional(),
      osVersion: z.string().max(50).optional(),
      screenResolution: z.string().max(20).optional(),
      fps: z.number().int().min(1).max(120).optional(),
      url: z.string().url().optional(),
      tabTitle: z.string().max(500).optional(),
      deviceInfo: z
        .object({
          type: z.enum(['desktop', 'mobile', 'tablet']).optional(),
          brand: z.string().max(100).optional(),
          model: z.string().max(100).optional(),
        })
        .optional(),
      consoleLogs: z
        .array(
          z.object({
            level: z.enum(['log', 'info', 'warn', 'error', 'debug']),
            message: z.string(),
            timestamp: z.number(),
            url: z.string().optional(),
            source: z.enum(['cdp', 'injected']).optional(),
          }),
        )
        .optional(),
      networkLogs: z
        .array(
          z.object({
            id: z.string().optional(),
            url: z.string(),
            method: z.string(),
            status: z.number(),
            statusText: z.string().optional(),
            duration: z.number(),
            timestamp: z.number(),
            size: z.number(),
            mimeType: z.string().optional(),
            failed: z.boolean().optional(),
            errorText: z.string().optional(),
            source: z.enum(['cdp', 'injected']).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export const updateRecordingSchema = z.object({
  title: z
    .string()
    .min(1, 'Title cannot be empty')
    .max(200, 'Title must not exceed 200 characters')
    .trim()
    .optional(),
  description: z
    .string()
    .max(2000, 'Description must not exceed 2000 characters')
    .trim()
    .nullable()
    .optional(),
  isPublic: z.boolean().optional(),
  allowDownload: z.boolean().optional(),
});

export const recordingQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 1))
    .pipe(z.number().int().positive().default(1)),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 20))
    .pipe(z.number().int().positive().max(100).default(20)),
  status: z.enum(['UPLOADING', 'PROCESSING', 'READY', 'FAILED']).optional(),
  type: z.enum(['SCREEN', 'TAB', 'WEBCAM', 'SCREENSHOT']).optional(),
  search: z.string().max(200).trim().optional(),
  sortBy: z
    .enum(['createdAt', 'updatedAt', 'viewCount', 'duration'])
    .optional()
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const recordingIdSchema = z.object({
  id: z.string().cuid('Invalid recording ID'),
});

export const shareIdSchema = z.object({
  shareId: z.string().min(1, 'Share ID is required'),
});

// Comment schemas
export const createCommentSchema = z.object({
  content: z
    .string({ required_error: 'Comment content is required' })
    .min(1, 'Comment cannot be empty')
    .max(5000, 'Comment must not exceed 5000 characters')
    .trim(),
  timestamp: z.number().min(0).optional().nullable(),
  parentId: z.string().cuid('Invalid parent comment ID').optional().nullable(),
});

export const updateCommentSchema = z.object({
  content: z
    .string({ required_error: 'Comment content is required' })
    .min(1, 'Comment cannot be empty')
    .max(5000, 'Comment must not exceed 5000 characters')
    .trim(),
});

// Share link schemas
export const createShareLinkSchema = z.object({
  recordingId: z.string().cuid('Invalid recording ID'),
  expiresAt: z.string().datetime().optional().nullable(),
  password: z.string().min(4, 'Password must be at least 4 characters').max(128).optional(),
  allowDownload: z.boolean().optional().default(true),
});

export const accessShareSchema = z.object({
  password: z.string().optional(),
});

// Team schemas
export const createTeamSchema = z.object({
  name: z
    .string({ required_error: 'Team name is required' })
    .min(2, 'Team name must be at least 2 characters')
    .max(100, 'Team name must not exceed 100 characters')
    .trim(),
  slug: z
    .string()
    .min(2, 'Slug must be at least 2 characters')
    .max(50, 'Slug must not exceed 50 characters')
    .regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens')
    .optional(),
});

export const inviteMemberSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email address')
    .toLowerCase()
    .trim(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).optional().default('MEMBER'),
});

export const acceptInviteSchema = z.object({
  token: z.string({ required_error: 'Invite token is required' }).min(1),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER'], {
    required_error: 'Role is required',
  }),
});

// Upload schemas
export const initiateUploadSchema = z.object({
  recordingId: z.string().cuid('Invalid recording ID'),
  totalChunks: z.number().int().positive().max(10000),
  mimeType: z.string().max(100).optional().default('video/webm'),
});

export const uploadChunkQuerySchema = z.object({
  recordingId: z.string().min(1, 'Recording ID is required'),
  chunkIndex: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(0)),
  totalChunks: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive()),
  checksum: z.string().optional(),
});

export type CreateRecordingInput = z.infer<typeof createRecordingSchema>;
export type UpdateRecordingInput = z.infer<typeof updateRecordingSchema>;
export type RecordingQueryInput = z.infer<typeof recordingQuerySchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;
export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type InitiateUploadInput = z.infer<typeof initiateUploadSchema>;
export type UploadChunkQueryInput = z.infer<typeof uploadChunkQuerySchema>;
