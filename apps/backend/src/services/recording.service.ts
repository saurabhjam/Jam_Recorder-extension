import type { Prisma, RecordingStatus, RecordingType } from '@prisma/client';

import { cacheKeys, cacheDel, cacheGet, cacheSet } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { AppError } from '../middleware/errorHandler';
import type {
  CreateRecordingInput,
  RecordingQueryInput,
  UpdateRecordingInput,
} from '../schemas/recording.schema';
import { CACHE_TTL } from '@snaptrace/config';

// ============================================================
// Recording Service
// ============================================================

export class RecordingService {
  /**
   * Create a new recording record (initial, before upload).
   */
  async createRecording(userId: string, data: CreateRecordingInput) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, teamId: true },
    });

    if (!user) {
      throw new AppError('User not found', 404, 'NOT_FOUND');
    }

    const recording = await prisma.recording.create({
      data: {
        userId,
        teamId: user.teamId,
        title: data.title ?? 'Untitled Recording',
        description: data.description,
        type: data.type as RecordingType,
        mimeType: data.mimeType ?? 'video/webm',
        status: 'UPLOADING',
        isPublic: true,
        metadata: data.metadata as Prisma.InputJsonValue,
      },
      include: {
        user: {
          select: { id: true, name: true, avatar: true },
        },
      },
    });

    return recording;
  }

  /**
   * Update recording metadata.
   */
  async updateRecording(id: string, userId: string, data: UpdateRecordingInput) {
    const recording = await this.assertOwnership(id, userId);

    const updated = await prisma.recording.update({
      where: { id: recording.id },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.isPublic !== undefined && { isPublic: data.isPublic }),
        ...(data.allowDownload !== undefined && { allowDownload: data.allowDownload }),
      },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
      },
    });

    // Invalidate cache
    await cacheDel(cacheKeys.recording(id));
    await cacheDel(cacheKeys.recordingPublic(updated.shareId));

    return updated;
  }

  /**
   * Get a recording by ID, with permission check.
   */
  async getRecording(id: string, userId: string) {
    const cacheKey = cacheKeys.recording(id);
    const cached = await cacheGet(cacheKey);
    if (cached) {
      const rec = cached as Awaited<ReturnType<typeof this.fetchRecordingById>>;
      this.assertAccess(rec, userId);
      return rec;
    }

    const recording = await this.fetchRecordingById(id);
    if (!recording) {
      throw new AppError('Recording not found', 404, 'NOT_FOUND');
    }

    this.assertAccess(recording, userId);

    await cacheSet(cacheKey, recording, CACHE_TTL.RECORDING);
    return recording;
  }

  /**
   * Get paginated list of recordings for a user.
   */
  async getUserRecordings(userId: string, query: RecordingQueryInput) {
    const { page, limit, status, type, search, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.RecordingWhereInput = {
      userId,
      ...(status && { status: status as RecordingStatus }),
      ...(type && { type: type as RecordingType }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [recordings, total] = await Promise.all([
      prisma.recording.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          user: { select: { id: true, name: true, avatar: true } },
          _count: { select: { comments: true } },
        },
      }),
      prisma.recording.count({ where }),
    ]);

    return {
      recordings,
      total,
      page,
      limit,
      hasMore: skip + recordings.length < total,
    };
  }

  /**
   * Delete a recording and clean up associated data.
   */
  async deleteRecording(id: string, userId: string): Promise<void> {
    const recording = await this.assertOwnership(id, userId);

    // Delete from database (cascades chunks, shareLinks, comments, analytics)
    await prisma.recording.delete({ where: { id: recording.id } });

    // Invalidate caches
    await cacheDel(cacheKeys.recording(id));
    await cacheDel(cacheKeys.recordingPublic(recording.shareId));

    // Note: Storage cleanup should be done via a background job
    // to avoid blocking the response. The job would handle Cloudinary deletion.
  }

  /**
   * Atomically increment view count.
   */
  async incrementViewCount(id: string): Promise<void> {
    await prisma.recording.update({
      where: { id },
      data: { viewCount: { increment: 1 } },
    });
    // Invalidate cache so next read gets fresh data
    await cacheDel(cacheKeys.recording(id));
  }

  /**
   * Get a public recording by shareId.
   */
  async getPublicRecording(shareId: string) {
    const cacheKey = cacheKeys.recordingPublic(shareId);
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return cached;
    }

    const recording = await prisma.recording.findUnique({
      where: { shareId, isPublic: true, status: 'READY' },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
        _count: { select: { comments: true } },
      },
    });

    if (!recording) {
      throw new AppError('Recording not found or not public', 404, 'NOT_FOUND');
    }

    await cacheSet(cacheKey, recording, CACHE_TTL.RECORDING);
    return recording;
  }

  /**
   * Update recording status (called internally by upload/processing pipeline).
   */
  async updateStatus(
    id: string,
    status: RecordingStatus,
    additionalData?: {
      url?: string;
      thumbnailUrl?: string;
      duration?: number;
      size?: bigint;
    },
  ) {
    const updated = await prisma.recording.update({
      where: { id },
      data: {
        status,
        ...additionalData,
      },
    });

    await cacheDel(cacheKeys.recording(id));
    await cacheDel(cacheKeys.recordingPublic(updated.shareId));

    return updated;
  }

  /**
   * Get recording analytics summary.
   */
  async getRecordingAnalytics(recordingId: string, userId: string) {
    // Verify ownership
    await this.assertOwnership(recordingId, userId);

    const [totalViews, uniqueVisitors, events, viewsByDay] = await Promise.all([
      prisma.analytics.count({
        where: { recordingId, event: 'view' },
      }),
      prisma.analytics.groupBy({
        by: ['visitorId'],
        where: { recordingId, event: 'view', visitorId: { not: null } },
        _count: true,
      }),
      prisma.analytics.groupBy({
        by: ['event'],
        where: { recordingId },
        _count: { event: true },
      }),
      prisma.analytics.groupBy({
        by: ['createdAt'],
        where: {
          recordingId,
          event: 'view',
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
          },
        },
        _count: { event: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      totalViews,
      uniqueVisitors: uniqueVisitors.length,
      eventBreakdown: events.reduce(
        (acc, e) => ({ ...acc, [e.event]: e._count.event }),
        {} as Record<string, number>,
      ),
      viewsByDay: viewsByDay.map((v) => ({
        date: v.createdAt.toISOString().split('T')[0],
        count: v._count.event,
      })),
    };
  }

  // ============================================================
  // Private Helpers
  // ============================================================

  private async fetchRecordingById(id: string) {
    return prisma.recording.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
        _count: { select: { comments: true } },
      },
    });
  }

  private assertAccess(
    recording: { userId: string; teamId: string | null; isPublic: boolean },
    userId: string,
  ): void {
    // Owner always has access
    if (recording.userId === userId) {
      return;
    }
    // Public recordings are accessible to anyone
    if (recording.isPublic) {
      return;
    }
    throw new AppError('You do not have access to this recording', 403, 'FORBIDDEN');
  }

  private async assertOwnership(recordingId: string, userId: string) {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { id: true, userId: true, shareId: true, status: true },
    });

    if (!recording) {
      throw new AppError('Recording not found', 404, 'NOT_FOUND');
    }

    if (recording.userId !== userId) {
      throw new AppError('You do not have permission to modify this recording', 403, 'FORBIDDEN');
    }

    return recording;
  }
}

export const recordingService = new RecordingService();
