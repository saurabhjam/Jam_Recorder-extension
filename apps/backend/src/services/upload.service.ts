import { cacheKeys, cacheSet, cacheDel } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { storage } from '../lib/storage';
import { AppError } from '../middleware/errorHandler';
import { queueVideoProcessing } from '../queues';
import { calculateChecksum, generateId } from '../utils/crypto';
import { CLOUDINARY_FOLDERS } from '@snaptrace/config';

// ============================================================
// Upload Service
// ============================================================

export class UploadService {
  /**
   * Initiate a chunked upload session.
   * Validates the recording exists and belongs to the user.
   */
  async initiateUpload(
    recordingId: string,
    userId: string,
    totalChunks: number,
  ): Promise<{ uploadId: string; recordingId: string; totalChunks: number }> {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { id: true, userId: true, status: true },
    });

    if (!recording) {
      throw new AppError('Recording not found', 404, 'NOT_FOUND');
    }

    if (recording.userId !== userId) {
      throw new AppError('Unauthorized', 403, 'FORBIDDEN');
    }

    if (recording.status !== 'UPLOADING') {
      throw new AppError(
        'Recording is not in UPLOADING state. Cannot re-initiate upload.',
        400,
        'INVALID_STATE',
      );
    }

    // Delete any previously uploaded chunks (for retry scenarios)
    await prisma.uploadChunk.deleteMany({ where: { recordingId } });

    const uploadId = generateId(24);

    // Store upload session metadata in cache
    await cacheSet(
      cacheKeys.uploadProgress(recordingId),
      { uploadId, totalChunks, uploadedChunks: 0, status: 'UPLOADING' },
      3600, // 1 hour TTL
    );

    return { uploadId, recordingId, totalChunks };
  }

  /**
   * Upload a single chunk.
   */
  async uploadChunk(
    recordingId: string,
    userId: string,
    chunkIndex: number,
    totalChunks: number,
    buffer: Buffer,
    providedChecksum?: string,
  ): Promise<{ chunkIndex: number; uploaded: boolean }> {
    // Verify recording ownership
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { id: true, userId: true, status: true },
    });

    if (!recording) {
      throw new AppError('Recording not found', 404, 'NOT_FOUND');
    }

    if (recording.userId !== userId) {
      throw new AppError('Unauthorized', 403, 'FORBIDDEN');
    }

    if (recording.status !== 'UPLOADING') {
      throw new AppError('Recording is not accepting chunks', 400, 'INVALID_STATE');
    }

    // Validate checksum if provided
    const computedChecksum = calculateChecksum(buffer);
    if (providedChecksum && computedChecksum !== providedChecksum) {
      throw new AppError(
        `Chunk ${chunkIndex} integrity check failed. Expected ${providedChecksum}, got ${computedChecksum}`,
        400,
        'CHECKSUM_MISMATCH',
      );
    }

    // Check if chunk already uploaded (for idempotency)
    const existingChunk = await prisma.uploadChunk.findUnique({
      where: { recordingId_chunkIndex: { recordingId, chunkIndex } },
    });

    if (existingChunk?.cloudUrl) {
      return { chunkIndex, uploaded: true }; // Already uploaded, idempotent
    }

    // Upload chunk to Cloudinary
    console.log(
      `[UPLOAD] chunk ${chunkIndex + 1}/${totalChunks} received — ${buffer.length} bytes — recording ${recordingId}`,
    );
    const uploadResult = await storage.upload(buffer, {
      folder: CLOUDINARY_FOLDERS.CHUNKS,
      publicId: `${recordingId}_chunk_${chunkIndex}`,
      resourceType: 'raw',
      tags: ['chunk', recordingId],
    });
    console.log(
      `[UPLOAD] chunk ${chunkIndex + 1}/${totalChunks} stored to Cloudinary — ${uploadResult.secureUrl}`,
    );

    // Upsert chunk record
    await prisma.uploadChunk.upsert({
      where: { recordingId_chunkIndex: { recordingId, chunkIndex } },
      create: {
        recordingId,
        chunkIndex,
        totalChunks,
        size: buffer.length,
        checksum: computedChecksum,
        cloudUrl: uploadResult.secureUrl,
      },
      update: {
        cloudUrl: uploadResult.secureUrl,
        checksum: computedChecksum,
        size: buffer.length,
        uploadedAt: new Date(),
      },
    });

    // Update progress in cache
    const uploadedCount = await prisma.uploadChunk.count({
      where: { recordingId, cloudUrl: { not: null } },
    });

    await cacheSet(
      cacheKeys.uploadProgress(recordingId),
      {
        totalChunks,
        uploadedChunks: uploadedCount,
        progress: Math.round((uploadedCount / totalChunks) * 100),
        status: 'UPLOADING',
      },
      3600,
    );

    return { chunkIndex, uploaded: true };
  }

  /**
   * Get the progress of an upload.
   */
  async getUploadProgress(recordingId: string, userId: string) {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { id: true, userId: true, status: true },
    });

    if (!recording) {
      throw new AppError('Recording not found', 404, 'NOT_FOUND');
    }

    if (recording.userId !== userId) {
      throw new AppError('Unauthorized', 403, 'FORBIDDEN');
    }

    const [uploadedChunks, totalChunksRecord] = await Promise.all([
      prisma.uploadChunk.count({
        where: { recordingId, cloudUrl: { not: null } },
      }),
      prisma.uploadChunk.findFirst({
        where: { recordingId },
        select: { totalChunks: true },
      }),
    ]);

    const totalChunks = totalChunksRecord?.totalChunks ?? 0;
    const progress = totalChunks > 0 ? Math.round((uploadedChunks / totalChunks) * 100) : 0;

    return {
      recordingId,
      uploadedChunks,
      totalChunks,
      progress,
      status: recording.status,
    };
  }

  /**
   * Finalize the upload — verify all chunks received, queue processing.
   */
  async finalizeUpload(recordingId: string, userId: string) {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: {
        id: true,
        userId: true,
        status: true,
        mimeType: true,
        shareId: true,
      },
    });

    if (!recording) {
      throw new AppError('Recording not found', 404, 'NOT_FOUND');
    }

    if (recording.userId !== userId) {
      throw new AppError('Unauthorized', 403, 'FORBIDDEN');
    }

    if (recording.status !== 'UPLOADING') {
      throw new AppError('Recording is not in UPLOADING state', 400, 'INVALID_STATE');
    }

    // Verify all chunks are uploaded
    const chunks = await prisma.uploadChunk.findMany({
      where: { recordingId },
      orderBy: { chunkIndex: 'asc' },
    });

    if (chunks.length === 0) {
      throw new AppError('No chunks found for this recording', 400, 'NO_CHUNKS');
    }

    const totalChunks = chunks[0]?.totalChunks ?? 0;
    const uploadedChunks = chunks.filter((c) => c.cloudUrl !== null).length;

    if (uploadedChunks < totalChunks) {
      throw new AppError(
        `Upload incomplete: ${uploadedChunks}/${totalChunks} chunks uploaded`,
        400,
        'INCOMPLETE_UPLOAD',
        { uploadedChunks, totalChunks },
      );
    }

    // Verify chunk continuity (no gaps)
    const chunkIndices = chunks.map((c) => c.chunkIndex).sort((a, b) => a - b);
    for (let i = 0; i < chunkIndices.length; i++) {
      if (chunkIndices[i] !== i) {
        throw new AppError(`Missing chunk at index ${i}`, 400, 'MISSING_CHUNK');
      }
    }

    // Update recording status to PROCESSING
    console.log(
      `[UPLOAD] all ${totalChunks} chunks verified — setting recording ${recordingId} to PROCESSING`,
    );
    await prisma.recording.update({
      where: { id: recordingId },
      data: { status: 'PROCESSING' },
    });

    // Queue video processing job
    await queueVideoProcessing({
      recordingId,
      userId,
      mimeType: recording.mimeType ?? 'video/webm',
      totalChunks,
    });
    console.log(
      `[QUEUE] video-processing job queued for recording ${recordingId} (${totalChunks} chunks, mimeType: ${recording.mimeType})`,
    );

    // Clean up progress cache
    await cacheDel(cacheKeys.uploadProgress(recordingId));

    return {
      recordingId,
      shareId: recording.shareId,
      status: 'PROCESSING',
      message: 'Upload complete. Processing started.',
    };
  }

  /**
   * Abort an upload and clean up chunks.
   */
  async abortUpload(recordingId: string, userId: string): Promise<void> {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { id: true, userId: true, status: true },
    });

    if (!recording) {
      throw new AppError('Recording not found', 404, 'NOT_FOUND');
    }

    if (recording.userId !== userId) {
      throw new AppError('Unauthorized', 403, 'FORBIDDEN');
    }

    // Queue cleanup job (deletion from Cloudinary)
    // For now, we'll just delete from DB and let Cloudinary chunks expire
    await prisma.uploadChunk.deleteMany({ where: { recordingId } });
    await prisma.recording.update({
      where: { id: recordingId },
      data: { status: 'FAILED' },
    });

    // Clear cache
    await cacheDel(cacheKeys.uploadProgress(recordingId));
  }

  /**
   * Clean up uploaded chunks from storage (called after video merge).
   */
  async cleanupChunks(recordingId: string): Promise<void> {
    const chunks = await prisma.uploadChunk.findMany({
      where: { recordingId },
      select: { cloudUrl: true },
    });

    // Delete chunks from storage in parallel
    const deletePromises = chunks
      .filter((c) => c.cloudUrl)
      .map(async (chunk) => {
        try {
          const publicId = this.extractPublicId(chunk.cloudUrl!);
          if (publicId) {
            await storage.delete(publicId);
          }
        } catch (err) {
          console.warn(`Failed to delete chunk ${chunk.cloudUrl}:`, err);
        }
      });

    await Promise.allSettled(deletePromises);

    // Remove chunk records from DB
    await prisma.uploadChunk.deleteMany({ where: { recordingId } });
  }

  private extractPublicId(url: string): string | null {
    // Extract Cloudinary public ID from URL
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
    return match?.[1] ?? null;
  }
}

export const uploadService = new UploadService();
