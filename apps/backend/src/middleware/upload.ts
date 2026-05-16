import type { NextFunction, Request, Response } from 'express';

import multer, { type FileFilterCallback } from 'multer';

import { config } from '../config';
import { AppError } from './errorHandler';

const ALLOWED_VIDEO_TYPES = [
  'video/webm',
  'video/mp4',
  'video/ogg',
  'video/avi',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'application/octet-stream', // Some browsers send chunks as octet-stream
];

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// ============================================================
// Memory Storage (for chunk uploads)
// ============================================================

const memoryStorage = multer.memoryStorage();

function videoFileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback): void {
  // Strip codec parameters (e.g. "video/webm;codecs=vp9,opus" → "video/webm")
  const baseMime = file.mimetype.split(';')[0]?.trim() ?? '';
  const allowed =
    ALLOWED_VIDEO_TYPES.some((t) => t.split(';')[0] === baseMime) ||
    baseMime.startsWith('video/') ||
    baseMime === 'application/octet-stream';
  if (allowed) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        `Invalid file type: ${file.mimetype}. Only video files are allowed.`,
        400,
        'INVALID_FILE_TYPE',
      ),
    );
  }
}

function imageFileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback): void {
  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        `Invalid file type: ${file.mimetype}. Only image files are allowed.`,
        400,
        'INVALID_FILE_TYPE',
      ),
    );
  }
}

// ============================================================
// Upload Middleware Instances
// ============================================================

export const uploadChunk = multer({
  storage: memoryStorage,
  limits: {
    fileSize: config.upload.chunkSize * 2, // Allow some buffer above chunk size
    files: 1,
  },
  fileFilter: videoFileFilter,
});

export const uploadVideo = multer({
  storage: memoryStorage,
  limits: {
    fileSize: config.upload.maxSize,
    files: 1,
  },
  fileFilter: videoFileFilter,
});

export const uploadImage = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB for images
    files: 1,
  },
  fileFilter: imageFileFilter,
});

export const uploadAvatar = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB for avatars
    files: 1,
  },
  fileFilter: imageFileFilter,
});

// ============================================================
// Error Handler Wrapper
// ============================================================

/**
 * Wraps multer middleware to properly handle multer errors in Express error pipeline.
 */
export function handleUploadError(uploadMiddleware: multer.Multer, fieldName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    uploadMiddleware.single(fieldName)(req, res, (err) => {
      if (!err) {
        return next();
      }

      if (err instanceof multer.MulterError) {
        switch (err.code) {
          case 'LIMIT_FILE_SIZE':
            return next(
              new AppError(
                `File size exceeds the maximum allowed limit of ${Math.floor(config.upload.chunkSize / (1024 * 1024))}MB per chunk`,
                400,
                'FILE_TOO_LARGE',
              ),
            );
          case 'LIMIT_FILE_COUNT':
            return next(
              new AppError(
                'Too many files. Only one file allowed per request.',
                400,
                'TOO_MANY_FILES',
              ),
            );
          case 'LIMIT_UNEXPECTED_FILE':
            return next(
              new AppError(`Unexpected field: ${err.field ?? fieldName}`, 400, 'UNEXPECTED_FILE'),
            );
          default:
            return next(new AppError(`Upload error: ${err.message}`, 400, 'UPLOAD_ERROR'));
        }
      }

      next(err);
    });
  };
}

/**
 * Validates that a file was actually uploaded.
 */
export function requireFile(req: Request, _res: Response, next: NextFunction): void {
  if (!req.file) {
    return next(new AppError('No file uploaded', 400, 'NO_FILE'));
  }
  next();
}
