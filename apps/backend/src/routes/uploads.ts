import { Router, type Request, type Response, type NextFunction } from 'express';

import { uploadService } from '../services/upload.service';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { handleUploadError, requireFile } from '../middleware/upload';
import { uploadRateLimiter } from '../middleware/rateLimit';
import { uploadChunk } from '../middleware/upload';
import { initiateUploadSchema, uploadChunkQuerySchema } from '../schemas/recording.schema';
import { broadcastUploadProgress } from '../lib/socket';

const router = Router();

// ============================================================
// POST /uploads/initiate — Start a chunked upload session
// ============================================================
router.post(
  '/initiate',
  requireAuth,
  validate(initiateUploadSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { recordingId, totalChunks } = req.body as {
        recordingId: string;
        totalChunks: number;
      };

      const result = await uploadService.initiateUpload(recordingId, req.user!.id, totalChunks);

      res.status(201).json({
        success: true,
        message: 'Upload session initiated',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// POST /uploads/chunk — Upload a single chunk
// ============================================================
router.post(
  '/chunk',
  requireAuth,
  uploadRateLimiter,
  handleUploadError(uploadChunk, 'chunk'),
  requireFile,
  validate(uploadChunkQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = req.query as {
        recordingId: string;
        chunkIndex: number;
        totalChunks: number;
        checksum?: string;
      };

      const result = await uploadService.uploadChunk(
        query.recordingId,
        req.user!.id,
        Number(query.chunkIndex),
        Number(query.totalChunks),
        req.file!.buffer,
        query.checksum,
      );

      // Broadcast upload progress via WebSocket
      const progress = Math.round(
        ((Number(query.chunkIndex) + 1) / Number(query.totalChunks)) * 100,
      );
      broadcastUploadProgress(
        req.user!.id,
        query.recordingId,
        progress,
        Number(query.chunkIndex) + 1,
        Number(query.totalChunks),
      );

      res.json({
        success: true,
        message: `Chunk ${query.chunkIndex} uploaded`,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// GET /uploads/progress/:recordingId — Get upload progress
// ============================================================
router.get(
  '/progress/:recordingId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const progress = await uploadService.getUploadProgress(
        req.params['recordingId']!,
        req.user!.id,
      );
      res.json({ success: true, data: progress });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// POST /uploads/complete/:recordingId — Finalize upload
// ============================================================
router.post(
  '/complete/:recordingId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await uploadService.finalizeUpload(req.params['recordingId']!, req.user!.id);
      res.json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// DELETE /uploads/abort/:recordingId — Abort and cleanup upload
// ============================================================
router.delete(
  '/abort/:recordingId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await uploadService.abortUpload(req.params['recordingId']!, req.user!.id);
      res.json({
        success: true,
        message: 'Upload aborted and cleaned up',
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
