import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { prisma } from '../lib/prisma';
import { cacheKeys, cacheSet, cacheGet, cacheDel } from '../lib/redis';
import { externalApi } from '../lib/external-api';
import { AppError } from '../middleware/errorHandler';
import { calculateChecksum, generateId } from '../utils/crypto';
import { config } from '../config';

// ─── Temp chunk storage ───────────────────────────────────────────────────────

function chunkDir(recordingId: string): string {
  return path.join(os.tmpdir(), 'snaptrace-uploads', recordingId);
}

function chunkPath(recordingId: string, chunkIndex: number): string {
  return path.join(chunkDir(recordingId), `chunk_${chunkIndex}`);
}

async function ensureChunkDir(recordingId: string): Promise<void> {
  await fs.mkdir(chunkDir(recordingId), { recursive: true });
}

async function deleteChunkDir(recordingId: string): Promise<void> {
  try {
    await fs.rm(chunkDir(recordingId), { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ─── Log formatters ───────────────────────────────────────────────────────────

interface ConsoleLogEntry {
  level?: string;
  message?: string;
  timestamp?: number;
  url?: string;
}

interface NetworkEntry {
  method?: string;
  url?: string;
  status?: number;
  statusText?: string;
  duration?: number;
  size?: number;
  failed?: boolean;
}

function formatConsoleLogs(logs: ConsoleLogEntry[]): string {
  if (!logs || logs.length === 0) return '';
  return logs
    .map((l) => {
      const level = (l.level ?? 'log').toUpperCase();
      const ts = l.timestamp ? new Date(l.timestamp).toISOString() : '';
      return `[${level}]${ts ? ` ${ts}` : ''} ${l.message ?? ''}`;
    })
    .join('\n');
}

function formatNetworkLogs(entries: NetworkEntry[]): string {
  if (!entries || entries.length === 0) return '';
  return entries
    .map((e) => {
      const status = e.failed ? 'FAILED' : (e.status ?? 0);
      const duration = e.duration != null ? `${e.duration}ms` : '';
      const size = e.size != null ? `${e.size}B` : '';
      const extra = [duration, size].filter(Boolean).join(', ');
      return `${e.method ?? 'GET'} ${e.url ?? ''} ${status}${extra ? ` (${extra})` : ''}`;
    })
    .join('\n');
}

// ─── Upload Session (Redis) ───────────────────────────────────────────────────

interface UploadSession {
  uploadId: string;
  totalChunks: number;
  uploadedChunks: number;
  status: 'UPLOADING' | 'DONE';
}

// ─── UploadService ────────────────────────────────────────────────────────────

export class UploadService {
  async initiateUpload(
    recordingId: string,
    userId: string,
    totalChunks: number,
  ): Promise<{ uploadId: string; recordingId: string; totalChunks: number }> {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { id: true, userId: true, status: true },
    });

    if (!recording) throw new AppError('Recording not found', 404, 'NOT_FOUND');
    if (recording.userId !== userId) throw new AppError('Unauthorized', 403, 'FORBIDDEN');
    if (recording.status !== 'UPLOADING') {
      throw new AppError('Recording is not in UPLOADING state', 400, 'INVALID_STATE');
    }

    // Clean up any leftover chunks from a previous attempt
    await deleteChunkDir(recordingId);
    await ensureChunkDir(recordingId);

    const uploadId = generateId(24);
    await cacheSet<UploadSession>(
      cacheKeys.uploadProgress(recordingId),
      { uploadId, totalChunks, uploadedChunks: 0, status: 'UPLOADING' },
      3600,
    );

    return { uploadId, recordingId, totalChunks };
  }

  async uploadChunk(
    recordingId: string,
    userId: string,
    chunkIndex: number,
    totalChunks: number,
    buffer: Buffer,
    providedChecksum?: string,
  ): Promise<{ chunkIndex: number; uploaded: boolean }> {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { id: true, userId: true, status: true },
    });

    if (!recording) throw new AppError('Recording not found', 404, 'NOT_FOUND');
    if (recording.userId !== userId) throw new AppError('Unauthorized', 403, 'FORBIDDEN');
    if (recording.status !== 'UPLOADING') {
      throw new AppError('Recording is not accepting chunks', 400, 'INVALID_STATE');
    }

    // Validate checksum if provided
    if (providedChecksum) {
      const computed = calculateChecksum(buffer);
      if (computed !== providedChecksum) {
        throw new AppError(`Chunk ${chunkIndex} integrity check failed`, 400, 'CHECKSUM_MISMATCH');
      }
    }

    // Write chunk to temp disk (idempotent — overwrite if re-uploaded)
    await ensureChunkDir(recordingId);
    await fs.writeFile(chunkPath(recordingId, chunkIndex), buffer);

    console.log(
      `[UPLOAD] chunk ${chunkIndex + 1}/${totalChunks} saved to disk — ${buffer.length} bytes — recording ${recordingId}`,
    );

    // Update Redis progress counter
    const session = await cacheGet<UploadSession>(cacheKeys.uploadProgress(recordingId));
    const uploadedChunks = session ? session.uploadedChunks + 1 : 1;
    await cacheSet<UploadSession>(
      cacheKeys.uploadProgress(recordingId),
      {
        uploadId: session?.uploadId ?? generateId(24),
        totalChunks,
        uploadedChunks,
        status: 'UPLOADING',
      },
      3600,
    );

    return { chunkIndex, uploaded: true };
  }

  async getUploadProgress(recordingId: string, userId: string) {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { id: true, userId: true, status: true },
    });

    if (!recording) throw new AppError('Recording not found', 404, 'NOT_FOUND');
    if (recording.userId !== userId) throw new AppError('Unauthorized', 403, 'FORBIDDEN');

    const session = await cacheGet<UploadSession>(cacheKeys.uploadProgress(recordingId));
    const totalChunks = session?.totalChunks ?? 0;
    const uploadedChunks = session?.uploadedChunks ?? 0;
    const progress = totalChunks > 0 ? Math.round((uploadedChunks / totalChunks) * 100) : 0;

    return { recordingId, uploadedChunks, totalChunks, progress, status: recording.status };
  }

  async finalizeUpload(recordingId: string, userId: string) {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: {
        id: true,
        userId: true,
        status: true,
        mimeType: true,
        shareId: true,
        title: true,
        description: true,
        isPublic: true,
        allowDownload: true,
        viewCount: true,
        duration: true,
        metadata: true,
        consoleLogs: true,
        networkLogs: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, email: true, name: true } },
      },
    });

    if (!recording) throw new AppError('Recording not found', 404, 'NOT_FOUND');
    if (recording.userId !== userId) throw new AppError('Unauthorized', 403, 'FORBIDDEN');
    if (recording.status !== 'UPLOADING') {
      throw new AppError('Recording is not in UPLOADING state', 400, 'INVALID_STATE');
    }

    // Retrieve upload session from Redis to know totalChunks
    const session = await cacheGet<UploadSession>(cacheKeys.uploadProgress(recordingId));
    if (!session) throw new AppError('Upload session not found or expired', 400, 'SESSION_EXPIRED');

    const { totalChunks } = session;

    // Verify all chunk files exist on disk
    const missingChunks: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
      try {
        await fs.access(chunkPath(recordingId, i));
      } catch {
        missingChunks.push(i);
      }
    }
    if (missingChunks.length > 0) {
      throw new AppError(
        `Missing chunks: [${missingChunks.join(', ')}]`,
        400,
        'INCOMPLETE_UPLOAD',
        { missingChunks, totalChunks },
      );
    }

    // Merge all chunks into a single buffer
    console.log(`[UPLOAD] merging ${totalChunks} chunks for recording ${recordingId}`);
    const chunkBuffers = await Promise.all(
      Array.from({ length: totalChunks }, (_, i) => fs.readFile(chunkPath(recordingId, i))),
    );
    const merged = Buffer.concat(chunkBuffers);
    console.log(`[UPLOAD] merged size: ${merged.length} bytes`);

    // Upload the merged file to the external files API
    const mimeType = recording.mimeType ?? 'video/webm';
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const filename = `${recordingId}.${ext}`;

    let fileUrl: string;
    try {
      fileUrl = await externalApi.uploadFile(merged, filename, mimeType);
      console.log(`[UPLOAD] file uploaded to external API: ${fileUrl}`);
    } catch (err) {
      console.error('[UPLOAD] external file upload failed:', err);
      throw new AppError(
        `File upload to external API failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
        'EXTERNAL_UPLOAD_FAILED',
      );
    }

    // Build console/network log strings from recording metadata
    const meta = recording.metadata as Record<string, unknown> | null;
    const consoleArr = (recording.consoleLogs ?? meta?.consoleLogs ?? []) as ConsoleLogEntry[];
    const networkArr = (recording.networkLogs ?? meta?.networkLogs ?? []) as NetworkEntry[];
    const consoleLogsStr = formatConsoleLogs(consoleArr);
    const networkLogsStr = formatNetworkLogs(networkArr);

    // Register the record in the external portal
    let shareUrl: string;
    let externalId: string;
    try {
      const result = await externalApi.createRecord({
        id: recordingId,
        title: recording.title,
        description: recording.description ?? '',
        userId: recording.user?.email ?? recording.userId,
        projectId: config.externalApi.projectId,
        status: 'completed',
        type: mimeType.startsWith('image/') ? 'screenshot' : 'video',
        url: fileUrl,
        thumbnailUrl: '',
        duration: recording.duration ?? 0,
        size: merged.length,
        mimeType,
        shareId: recording.shareId,
        isPublic: recording.isPublic,
        allowDownload: recording.allowDownload,
        viewCount: recording.viewCount,
        metadata: JSON.stringify(meta ?? {}),
        createdAt: recording.createdAt.toISOString(),
        updatedAt: new Date().toISOString(),
        consoleLogs: consoleLogsStr,
        networkLogs: networkLogsStr,
      });
      externalId = result.id;
      // Always serve via our own share page — not the external portal's blank UI
      shareUrl = `${config.server.frontendUrl}/share/${recording.shareId}`;
      console.log(`[UPLOAD] record created in external portal: ${result.shareUrl}`);
      console.log(`[UPLOAD] share URL: ${shareUrl}`);
    } catch (err) {
      console.error('[UPLOAD] external record creation failed:', err);
      throw new AppError(
        `Record creation in external portal failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
        'EXTERNAL_RECORD_FAILED',
      );
    }

    // Update local Prisma recording to READY with the file URL
    await prisma.recording.update({
      where: { id: recordingId },
      data: {
        status: 'READY',
        url: fileUrl,
        size: BigInt(merged.length),
      },
    });

    // Clean up temp files and Redis session
    await deleteChunkDir(recordingId);
    await cacheDel(cacheKeys.uploadProgress(recordingId));

    return {
      recordingId,
      shareId: externalId,
      shareUrl,
      status: 'READY',
      message: 'Upload complete. Recording saved to external portal.',
    };
  }

  async abortUpload(recordingId: string, userId: string): Promise<void> {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { id: true, userId: true, status: true },
    });

    if (!recording) throw new AppError('Recording not found', 404, 'NOT_FOUND');
    if (recording.userId !== userId) throw new AppError('Unauthorized', 403, 'FORBIDDEN');

    await deleteChunkDir(recordingId);
    await cacheDel(cacheKeys.uploadProgress(recordingId));
    await prisma.recording.update({
      where: { id: recordingId },
      data: { status: 'FAILED' },
    });
  }
}

export const uploadService = new UploadService();
