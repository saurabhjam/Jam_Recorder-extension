import type { Prisma, RecordingStatus, RecordingType } from '@prisma/client';

import { prisma } from '../lib/prisma';
import { AppError } from '../middleware/errorHandler';
import type {
  CreateRecordingInput,
  RecordingQueryInput,
  UpdateRecordingInput,
} from '../schemas/recording.schema';

// ============================================================
// Recording Service — no Redis caching; queries DB directly
// ============================================================

export class RecordingService {
  async createRecording(userId: string, data: CreateRecordingInput) {
    return prisma.recording.create({
      data: {
        userId,
        title: data.title ?? 'Untitled Recording',
        description: data.description,
        type: data.type as RecordingType,
        mimeType: data.mimeType ?? 'video/webm',
        status: 'UPLOADING',
        isPublic: true,
        metadata: (data.metadata ?? null) as Prisma.InputJsonValue,
      },
    });
  }

  async updateRecording(id: string, userId: string, data: UpdateRecordingInput) {
    await this.assertOwnership(id, userId);

    return prisma.recording.update({
      where: { id },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.isPublic !== undefined && { isPublic: data.isPublic }),
        ...(data.allowDownload !== undefined && { allowDownload: data.allowDownload }),
      },
    });
  }

  async getRecording(id: string, userId: string) {
    const recording = await this.fetchRecordingById(id);
    if (!recording) throw new AppError('Recording not found', 404, 'NOT_FOUND');
    this.assertAccess(recording, userId);
    return recording;
  }

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
          _count: { select: { comments: true } },
        },
      }),
      prisma.recording.count({ where }),
    ]);

    return { recordings, total, page, limit, hasMore: skip + recordings.length < total };
  }

  async deleteRecording(id: string, userId: string): Promise<void> {
    const recording = await this.assertOwnership(id, userId);
    await prisma.recording.delete({ where: { id: recording.id } });
  }

  async incrementViewCount(id: string, _shareId?: string): Promise<void> {
    await prisma.recording.update({
      where: { id },
      data: { viewCount: { increment: 1 } },
    });
  }

  async getPublicRecording(shareId: string) {
    const recording = await prisma.recording.findFirst({
      where: { shareId, isPublic: true, status: { in: ['UPLOADING', 'PROCESSING', 'READY'] } },
      include: {
        _count: { select: { comments: true } },
      },
    });

    if (!recording) {
      console.log(`[SHARE] recording not found or not public — shareId: ${shareId}`);
      throw new AppError('Recording not found or not public', 404, 'NOT_FOUND');
    }

    console.log(
      `[SHARE] recording fetched — shareId: ${shareId}, status: ${recording.status}, id: ${recording.id}`,
    );

    return recording;
  }

  async updateStatus(
    id: string,
    status: RecordingStatus,
    additionalData?: { url?: string; thumbnailUrl?: string; duration?: number; size?: bigint },
  ) {
    return prisma.recording.update({
      where: { id },
      data: { status, ...additionalData },
    });
  }

  async getRecordingAnalytics(recordingId: string, userId: string) {
    await this.assertOwnership(recordingId, userId);

    const [totalViews, uniqueVisitors, events, viewsByDay] = await Promise.all([
      prisma.analytics.count({ where: { recordingId, event: 'view' } }),
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
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
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

  // ── Private helpers ────────────────────────────────────────────────────────

  private async fetchRecordingById(id: string) {
    return prisma.recording.findUnique({
      where: { id },
      include: {
        _count: { select: { comments: true } },
      },
    });
  }

  private assertAccess(
    recording: { userId: string; teamId: string | null; isPublic: boolean },
    userId: string,
  ): void {
    if (recording.userId === userId || recording.isPublic) return;
    throw new AppError('You do not have access to this recording', 403, 'FORBIDDEN');
  }

  private async assertOwnership(recordingId: string, userId: string) {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { id: true, userId: true, shareId: true, status: true },
    });

    if (!recording) throw new AppError('Recording not found', 404, 'NOT_FOUND');
    if (recording.userId !== userId)
      throw new AppError('You do not have permission to modify this recording', 403, 'FORBIDDEN');

    return recording;
  }
}

export const recordingService = new RecordingService();
