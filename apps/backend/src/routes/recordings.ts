import { Router, type Request, type Response, type NextFunction } from 'express';

import { recordingService } from '../services/recording.service';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createRecordingSchema,
  updateRecordingSchema,
  recordingQuerySchema,
  recordingIdSchema,
  shareIdSchema,
} from '../schemas/recording.schema';
import { queueAnalyticsEvent } from '../queues';
import { generateVisitorId } from '../utils/crypto';

const router = Router();

// ============================================================
// GET /recordings — List user recordings (paginated)
// ============================================================
router.get(
  '/',
  requireAuth,
  validate(recordingQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await recordingService.getUserRecordings(req.user!.id, req.query as any);
      res.json({
        success: true,
        data: result.recordings,
        total: result.total,
        page: result.page,
        limit: result.limit,
        hasMore: result.hasMore,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// POST /recordings — Create a recording record
// ============================================================
router.post(
  '/',
  requireAuth,
  validate(createRecordingSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const recording = await recordingService.createRecording(req.user!.id, req.body);
      res.status(201).json({
        success: true,
        message: 'Recording created',
        data: recording,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// GET /recordings/public/:shareId — Get public recording
// ============================================================
router.get(
  '/public/:shareId',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { shareId } = req.params;
      const recording = await recordingService.getPublicRecording(shareId!);

      // Track analytics event (fire and forget)
      const visitorId = generateVisitorId(
        req.ip ?? 'unknown',
        req.get('User-Agent') ?? 'unknown',
        shareId!,
      );

      queueAnalyticsEvent({
        event: 'view',
        recordingId: recording.id,
        userId: req.user?.id,
        visitorId,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        referer: req.get('Referer'),
      }).catch((err) => console.error('Failed to queue analytics:', err));

      res.json({ success: true, data: recording });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// GET /recordings/:id — Get a single recording
// ============================================================
router.get(
  '/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const recording = await recordingService.getRecording(req.params['id']!, req.user!.id);
      res.json({ success: true, data: recording });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// PUT /recordings/:id — Update a recording
// ============================================================
router.put(
  '/:id',
  requireAuth,
  validate(updateRecordingSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const updated = await recordingService.updateRecording(
        req.params['id']!,
        req.user!.id,
        req.body,
      );
      res.json({
        success: true,
        message: 'Recording updated',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// DELETE /recordings/:id — Delete a recording
// ============================================================
router.delete(
  '/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await recordingService.deleteRecording(req.params['id']!, req.user!.id);
      res.json({
        success: true,
        message: 'Recording deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// POST /recordings/:id/view — Increment view count
// ============================================================
router.post(
  '/:id/view',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await recordingService.incrementViewCount(req.params['id']!);
      res.json({ success: true, message: 'View recorded' });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// GET /recordings/:id/analytics — Recording analytics
// ============================================================
router.get(
  '/:id/analytics',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const analytics = await recordingService.getRecordingAnalytics(
        req.params['id']!,
        req.user!.id,
      );
      res.json({ success: true, data: analytics });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
