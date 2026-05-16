import { Router, type Request, type Response, type NextFunction } from 'express';

import { shareService } from '../services/share.service';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { shareViewRateLimiter } from '../middleware/rateLimit';
import { createShareLinkSchema, accessShareSchema } from '../schemas/recording.schema';

const router = Router();

// ============================================================
// POST /shares — Create a share link
// ============================================================
router.post(
  '/',
  requireAuth,
  validate(createShareLinkSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const shareLink = await shareService.createShareLink(req.user!.id, req.body);
      res.status(201).json({
        success: true,
        message: 'Share link created',
        data: shareLink,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// GET /shares/recording/:recordingId — List share links for a recording
// ============================================================
router.get(
  '/recording/:recordingId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const shareLinks = await shareService.getShareLinksForRecording(
        req.params['recordingId']!,
        req.user!.id,
      );
      res.json({ success: true, data: shareLinks });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// GET /shares/:token — Access a shared recording
// ============================================================
router.get(
  '/:token',
  shareViewRateLimiter,
  optionalAuth,
  validate(accessShareSchema, 'query'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const password = (req.query as { password?: string }).password;
      const result = await shareService.getSharedRecording(req.params['token']!, password);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// DELETE /shares/:token — Delete a share link
// ============================================================
router.delete(
  '/:token',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await shareService.deleteShareLink(req.params['token']!, req.user!.id);
      res.json({
        success: true,
        message: 'Share link deleted',
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
