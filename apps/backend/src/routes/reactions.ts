import { Router, type Request, type Response, type NextFunction } from 'express';

import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/auth';
import { generateVisitorId } from '../utils/crypto';

const router = Router({ mergeParams: true });

// GET /recordings/:id/reactions — get reaction counts + caller's active reactions
router.get(
  '/',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const recordingId = req.params['id']!;
      const userId = (req.user as { id: string } | undefined)?.id ?? null;
      const visitorId = generateVisitorId(
        req.ip ?? 'unknown',
        req.get('User-Agent') ?? 'unknown',
        recordingId,
      );

      const reactions = await prisma.reaction.groupBy({
        by: ['emoji'],
        where: { recordingId },
        _count: { emoji: true },
      });

      // Find which emojis this viewer has already reacted with
      const myReactions = await prisma.reaction.findMany({
        where: {
          recordingId,
          OR: [...(userId ? [{ userId }] : []), { visitorId }],
        },
        select: { emoji: true },
      });

      const counts: Record<string, number> = {};
      for (const r of reactions) counts[r.emoji] = r._count.emoji;

      res.json({
        success: true,
        data: {
          counts,
          mine: myReactions.map((r) => r.emoji),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /recordings/:id/reactions — toggle a reaction
router.post(
  '/',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const recordingId = req.params['id']!;
      const { emoji } = req.body as { emoji: string };

      if (!emoji) {
        res.status(400).json({ success: false, message: 'emoji is required' });
        return;
      }

      const userId = (req.user as { id: string } | undefined)?.id ?? null;
      const visitorId = generateVisitorId(
        req.ip ?? 'unknown',
        req.get('User-Agent') ?? 'unknown',
        recordingId,
      );

      // Check if reaction already exists
      const existing = await prisma.reaction.findFirst({
        where: {
          recordingId,
          emoji,
          OR: [...(userId ? [{ userId }] : []), { visitorId }],
        },
      });

      if (existing) {
        // Toggle off
        await prisma.reaction.delete({ where: { id: existing.id } });
      } else {
        // Toggle on
        await prisma.reaction.create({
          data: {
            recordingId,
            emoji,
            userId: userId ?? null,
            visitorId: userId ? null : visitorId,
          },
        });
      }

      // Return updated counts
      const reactions = await prisma.reaction.groupBy({
        by: ['emoji'],
        where: { recordingId },
        _count: { emoji: true },
      });
      const myReactions = await prisma.reaction.findMany({
        where: {
          recordingId,
          OR: [...(userId ? [{ userId }] : []), { visitorId }],
        },
        select: { emoji: true },
      });

      const counts: Record<string, number> = {};
      for (const r of reactions) counts[r.emoji] = r._count.emoji;

      res.json({
        success: true,
        data: {
          counts,
          mine: myReactions.map((r) => r.emoji),
          toggled: existing ? 'removed' : 'added',
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
