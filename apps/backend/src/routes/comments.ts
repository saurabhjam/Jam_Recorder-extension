import { Router, type Request, type Response, type NextFunction } from 'express';

import { prisma } from '../lib/prisma';
import { broadcastNewComment } from '../lib/socket';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { createCommentSchema, updateCommentSchema } from '../schemas/recording.schema';
import { generateVisitorId } from '../utils/crypto';

const router = Router({ mergeParams: true });

// ============================================================
// GET /recordings/:id/comments — List comments for a recording
// ============================================================
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const recordingId = req.params['id']!;

    // Verify recording exists and is accessible
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { id: true, isPublic: true, userId: true },
    });

    if (!recording) {
      throw new AppError('Recording not found', 404, 'NOT_FOUND');
    }

    const page = parseInt(String(req.query['page'] ?? '1'), 10);
    const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10), 100);
    const skip = (page - 1) * limit;

    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where: {
          recordingId,
          parentId: null, // Only top-level comments
        },
        include: {
          replies: {
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      prisma.comment.count({ where: { recordingId, parentId: null } }),
    ]);

    res.json({
      success: true,
      data: comments,
      total,
      page,
      limit,
      hasMore: skip + comments.length < total,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// POST /recordings/:id/comments — Create a comment (auth optional — guests allowed)
// ============================================================
router.post(
  '/',
  optionalAuth,
  validate(createCommentSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const recordingId = req.params['id']!;
      const { content, timestamp, parentId, guestName } = req.body as {
        content: string;
        timestamp?: number | null;
        parentId?: string | null;
        guestName?: string;
      };

      // Verify recording exists
      const recording = await prisma.recording.findUnique({
        where: { id: recordingId },
        select: { id: true, isPublic: true, userId: true, teamId: true },
      });

      if (!recording) {
        throw new AppError('Recording not found', 404, 'NOT_FOUND');
      }

      // Private recordings: only the owner can comment
      const userId = (req.user as { id: string } | undefined)?.id ?? null;
      if (!recording.isPublic && recording.userId !== userId) {
        throw new AppError('Cannot comment on this recording', 403, 'FORBIDDEN');
      }

      // Guests on public recordings must provide a name
      if (!userId && (!guestName || !guestName.trim())) {
        throw new AppError('Please provide your name to comment', 400, 'GUEST_NAME_REQUIRED');
      }

      // Validate parent comment if provided
      if (parentId) {
        const parentComment = await prisma.comment.findUnique({
          where: { id: parentId },
          select: { id: true, recordingId: true },
        });

        if (!parentComment || parentComment.recordingId !== recordingId) {
          throw new AppError('Parent comment not found', 404, 'NOT_FOUND');
        }
      }

      const comment = await prisma.comment.create({
        data: {
          recordingId,
          userId: userId ?? null,
          guestName: userId ? null : (guestName?.trim() ?? 'Guest'),
          content,
          timestamp: timestamp ?? null,
          parentId: parentId ?? null,
        },
        include: {
          replies: true,
        },
      });

      // Broadcast new comment via WebSocket
      broadcastNewComment(recordingId, comment);

      res.status(201).json({
        success: true,
        message: 'Comment added',
        data: comment,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// PUT /recordings/:id/comments/:commentId — Update a comment
// ============================================================
router.put(
  '/:commentId',
  requireAuth,
  validate(updateCommentSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { commentId } = req.params as { commentId: string };
      const { content } = req.body as { content: string };

      const comment = await prisma.comment.findUnique({
        where: { id: commentId },
        select: { id: true, userId: true },
      });

      if (!comment) {
        throw new AppError('Comment not found', 404, 'NOT_FOUND');
      }

      if (comment.userId !== req.user!.id) {
        throw new AppError('You can only edit your own comments', 403, 'FORBIDDEN');
      }

      const updated = await prisma.comment.update({
        where: { id: commentId },
        data: { content },
      });

      res.json({
        success: true,
        message: 'Comment updated',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// DELETE /recordings/:id/comments/:commentId — Delete a comment
// ============================================================
router.delete(
  '/:commentId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { commentId } = req.params as { commentId: string };

      const comment = await prisma.comment.findUnique({
        where: { id: commentId },
        include: {
          recording: { select: { userId: true } },
        },
      });

      if (!comment) {
        throw new AppError('Comment not found', 404, 'NOT_FOUND');
      }

      // Allow deletion by comment author or recording owner
      const canDelete =
        comment.userId === req.user!.id || comment.recording.userId === req.user!.id;

      if (!canDelete) {
        throw new AppError('You cannot delete this comment', 403, 'FORBIDDEN');
      }

      await prisma.comment.delete({ where: { id: commentId } });

      res.json({
        success: true,
        message: 'Comment deleted',
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
