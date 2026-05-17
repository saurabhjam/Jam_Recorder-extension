import { Worker, Job, type ConnectionOptions } from 'bullmq';
import { promises as fs } from 'fs';
import path from 'path';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { createRedisConnection } from '../lib/redis';
import { uploadFile } from '../lib/storage';
import {
  mergeVideoChunks,
  optimizeVideo,
  getVideoMetadata,
  checkFfmpegAvailable,
  type ProgressEvent,
} from '../processors/ffmpeg.processor';
import { logger, createChildLogger } from '../utils/logger';

const QUEUE_NAME = process.env.VIDEO_QUEUE_NAME ?? 'video-processing';
const TEMP_DIR = process.env.TEMP_DIR ?? '/tmp/jam-worker';
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '3');

export interface VideoProcessingJobData {
  recordingId: string;
  userId: string;
  mimeType: string;
  totalChunks: number;
}

/** Download a chunk file from a URL to local temp path */
async function downloadChunk(url: string, destPath: string): Promise<void> {
  const response = await axios.get<NodeJS.ReadableStream>(url, { responseType: 'stream' });
  const writer = (await import('fs')).createWriteStream(destPath);

  await new Promise<void>((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

/** Update recording status in database */
async function updateRecordingStatus(
  recordingId: string,
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED',
  extra?: Record<string, unknown>,
): Promise<void> {
  await prisma.recording.update({
    where: { id: recordingId },
    data: { status, ...extra, updatedAt: new Date() },
  });
}

/** Add a thumbnail job to the queue */
async function enqueueThumbnailJob(recordingId: string, videoUrl: string): Promise<void> {
  const { Queue } = await import('bullmq');
  const connection = createRedisConnection();
  const thumbnailQueue = new Queue(process.env.THUMBNAIL_QUEUE_NAME ?? 'thumbnail-generation', {
    connection,
  });
  await thumbnailQueue.add('generate', { recordingId, videoUrl });
  await thumbnailQueue.close();
  await connection.quit();
}

/** Add a notification job to the queue */
async function enqueueNotification(
  userId: string,
  type: string,
  title: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const { Queue } = await import('bullmq');
  const connection = createRedisConnection();
  const notifQueue = new Queue(process.env.NOTIFICATION_QUEUE_NAME ?? 'notifications', {
    connection,
  });
  await notifQueue.add('notify', { userId, type, title, message, metadata });
  await notifQueue.close();
  await connection.quit();
}

/** Process a single video job */
async function processVideoJob(job: Job<VideoProcessingJobData>): Promise<void> {
  const { recordingId, userId, mimeType: _mimeType, totalChunks } = job.data;
  const log = createChildLogger({ recordingId, userId, jobId: job.id });
  const workDir = path.join(TEMP_DIR, `rec_${recordingId}_${Date.now()}`);

  log.info('Video processing started', { totalChunks });

  try {
    // ── 1. Create working directory ────────────────────────────────────
    await fs.mkdir(workDir, { recursive: true });

    // ── 2. Set status to PROCESSING ────────────────────────────────────
    await updateRecordingStatus(recordingId, 'PROCESSING');
    await job.updateProgress(5);

    // ── 3. Fetch chunk URLs from database ──────────────────────────────
    const chunks = await prisma.uploadChunk.findMany({
      where: { recordingId },
      orderBy: { chunkIndex: 'asc' },
    });

    if (chunks.length === 0) {
      throw new Error('No upload chunks found for recording');
    }

    log.info(`Found ${chunks.length} chunks, downloading...`);

    // ── 4. Download all chunks ─────────────────────────────────────────
    const chunkPaths: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk.cloudUrl) {
        throw new Error(`Chunk ${chunk.chunkIndex} has no cloud URL`);
      }

      const chunkPath = path.join(
        workDir,
        `chunk_${String(chunk.chunkIndex).padStart(5, '0')}.webm`,
      );
      await downloadChunk(chunk.cloudUrl, chunkPath);
      chunkPaths.push(chunkPath);

      const progress = 5 + Math.floor(((i + 1) / chunks.length) * 30);
      await job.updateProgress(progress);
      log.debug(`Downloaded chunk ${i + 1}/${chunks.length}`);
    }

    // ── 5. Check ffmpeg and fall back to direct concat if unavailable ──
    const ffmpegAvailable = await checkFfmpegAvailable();

    if (!ffmpegAvailable) {
      log.warn('FFmpeg not available — concatenating chunks directly (no re-encode)');

      const fallbackPath = path.join(workDir, 'recording.webm');
      const parts = await Promise.all(chunkPaths.map((p) => fs.readFile(p)));
      await fs.writeFile(fallbackPath, Buffer.concat(parts));
      await job.updateProgress(60);

      log.info('Uploading concatenated recording to Cloudinary...');
      const uploadResult = await uploadFile(fallbackPath, {
        folder: `jam-recordings/${userId}`,
        publicId: `rec_${recordingId}`,
        resourceType: 'video',
        tags: ['recording', `user_${userId}`],
        metadata: { recordingId, userId },
      });

      await job.updateProgress(95);
      log.info('Upload complete (no-ffmpeg fallback)', { url: uploadResult.secureUrl });

      await updateRecordingStatus(recordingId, 'READY', {
        url: uploadResult.secureUrl,
        size: BigInt(uploadResult.size),
        duration: uploadResult.duration ?? null,
        mimeType: 'video/webm',
      });

      await enqueueNotification(
        userId,
        'RECORDING_READY',
        'Recording ready',
        'Your recording is ready to share.',
        { recordingId },
      );

      await job.updateProgress(100);
      log.info('Video processing complete (no-ffmpeg fallback)');
      return;
    }

    // ── 6. Merge chunks ────────────────────────────────────────────────
    log.info('Merging video chunks...');
    const mergedPath = path.join(workDir, 'merged.webm');

    await mergeVideoChunks(chunkPaths, mergedPath, async (ev: ProgressEvent) => {
      if (ev.percent) {
        const progress = 35 + Math.floor(ev.percent * 0.15);
        await job.updateProgress(progress);
      }
    });

    await job.updateProgress(50);
    log.info('Chunks merged successfully');

    // ── 6. Get video metadata ──────────────────────────────────────────
    const metadata = await getVideoMetadata(mergedPath);
    log.info('Got video metadata', {
      duration: metadata.duration,
      resolution: `${metadata.width}x${metadata.height}`,
    });

    // ── 7. Optimize video ──────────────────────────────────────────────
    log.info('Optimizing video...');
    const optimizedPath = path.join(workDir, 'optimized.mp4');

    const targetHeight = metadata.height > 1080 ? 1080 : metadata.height;
    const targetWidth = metadata.width > 1920 ? 1920 : metadata.width;

    await optimizeVideo(
      mergedPath,
      optimizedPath,
      {
        width: targetWidth,
        height: targetHeight,
        videoBitrate: metadata.videoBitrate > 4_000_000 ? '3000k' : '2000k',
        audioBitrate: '128k',
        fps: Math.min(metadata.fps, 60),
        crf: 23,
        format: 'mp4',
      },
      async (ev: ProgressEvent) => {
        if (ev.percent) {
          const progress = 50 + Math.floor(ev.percent * 0.3);
          await job.updateProgress(progress);
        }
      },
    );

    await job.updateProgress(80);
    log.info('Video optimized successfully');

    // ── 8. Get final metadata ──────────────────────────────────────────
    const finalMeta = await getVideoMetadata(optimizedPath);

    // ── 9. Upload to Cloudinary ────────────────────────────────────────
    log.info('Uploading to Cloudinary...');
    const uploadResult = await uploadFile(optimizedPath, {
      folder: `jam-recordings/${userId}`,
      publicId: `rec_${recordingId}`,
      resourceType: 'video',
      tags: ['recording', `user_${userId}`],
      metadata: { recordingId, userId },
    });

    await job.updateProgress(95);
    log.info('Upload complete', { url: uploadResult.secureUrl });

    // ── 10. Update recording to READY ──────────────────────────────────
    await updateRecordingStatus(recordingId, 'READY', {
      url: uploadResult.secureUrl,
      size: finalMeta.size,
      duration: finalMeta.duration,
      mimeType: 'video/mp4',
    });

    // ── 11. Trigger thumbnail generation ──────────────────────────────
    await enqueueThumbnailJob(recordingId, uploadResult.secureUrl);

    // ── 12. Notify user ────────────────────────────────────────────────
    await enqueueNotification(
      userId,
      'RECORDING_READY',
      'Recording ready',
      'Your recording has been processed and is ready to share.',
      { recordingId },
    );

    await job.updateProgress(100);
    log.info('Video processing complete');
  } catch (error) {
    log.error('Video processing failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Update status to FAILED
    await updateRecordingStatus(recordingId, 'FAILED').catch(() => {});

    throw error; // Re-throw so BullMQ retries/fails the job
  } finally {
    // Clean up temp files
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    log.debug('Temp directory cleaned up', { workDir });
  }
}

/** Create and start the video processing worker */
export function createVideoWorker(connection: ConnectionOptions): Worker<VideoProcessingJobData> {
  const worker = new Worker<VideoProcessingJobData>(QUEUE_NAME, processVideoJob, {
    connection,
    concurrency: CONCURRENCY,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  });

  worker.on('active', (job) => {
    logger.info(`[VideoWorker] Job started`, { jobId: job.id, recordingId: job.data.recordingId });
  });

  worker.on('completed', (job) => {
    logger.info(`[VideoWorker] Job completed`, {
      jobId: job.id,
      recordingId: job.data.recordingId,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error(`[VideoWorker] Job failed`, {
      jobId: job?.id,
      recordingId: job?.data?.recordingId,
      error: err.message,
      attemptsMade: job?.attemptsMade,
    });
  });

  worker.on('progress', (job, progress) => {
    logger.debug(`[VideoWorker] Job progress`, { jobId: job.id, progress });
  });

  worker.on('error', (err) => {
    logger.error(`[VideoWorker] Worker error`, { error: err.message });
  });

  logger.info(`[VideoWorker] Started`, { queue: QUEUE_NAME, concurrency: CONCURRENCY });

  return worker;
}
