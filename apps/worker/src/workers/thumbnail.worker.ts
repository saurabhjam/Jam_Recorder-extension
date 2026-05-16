import { Worker, Job, type ConnectionOptions } from 'bullmq';
import { promises as fs } from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma';
import { uploadFile } from '../lib/storage';
import { extractThumbnail, checkFfmpegAvailable } from '../processors/ffmpeg.processor';
import { logger, createChildLogger } from '../utils/logger';

const QUEUE_NAME = process.env.THUMBNAIL_QUEUE_NAME ?? 'thumbnail-generation';
const TEMP_DIR = process.env.TEMP_DIR ?? '/tmp/jam-worker';

export interface ThumbnailJobData {
  recordingId: string;
  videoUrl: string;
  timestamp?: number;
}

/** Download video to temp path via streaming */
async function downloadVideoPartial(url: string, destPath: string): Promise<void> {
  const axios = (await import('axios')).default;
  const fs_mod = await import('fs');

  const response = await axios.get<NodeJS.ReadableStream>(url, {
    responseType: 'stream',
    headers: {
      // Request only the first ~10 MB to extract the thumbnail quickly
      Range: 'bytes=0-10485760',
    },
    validateStatus: (s) => s < 400,
  });

  const writer = fs_mod.createWriteStream(destPath);
  await new Promise<void>((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });
}

async function processThumbnailJob(job: Job<ThumbnailJobData>): Promise<void> {
  const { recordingId, videoUrl, timestamp = 1 } = job.data;
  const log = createChildLogger({ recordingId, jobId: job.id });
  const workDir = path.join(TEMP_DIR, `thumb_${recordingId}_${Date.now()}`);

  log.info('Thumbnail generation started', { videoUrl, timestamp });

  try {
    // ── 1. Create working directory ──────────────────────────────────
    await fs.mkdir(workDir, { recursive: true });

    // ── 2. Download enough of the video to extract a frame ────────────
    const videoPath = path.join(workDir, 'source.mp4');
    const thumbnailPath = path.join(workDir, 'thumbnail.jpg');

    log.debug('Downloading video for thumbnail extraction...');
    await downloadVideoPartial(videoUrl, videoPath);
    await job.updateProgress(40);

    // ── 3. Extract frame with FFmpeg ──────────────────────────────────
    log.debug('Extracting frame...', { timestamp });
    try {
      await extractThumbnail(videoPath, thumbnailPath, timestamp, 1280, 720);
    } catch (err) {
      // If the requested timestamp is beyond the partial download, try t=0
      log.warn('Failed at requested timestamp, retrying at t=0', { error: (err as Error).message });
      await extractThumbnail(videoPath, thumbnailPath, 0, 1280, 720);
    }

    await job.updateProgress(70);

    // ── 4. Upload thumbnail to Cloudinary ─────────────────────────────
    log.debug('Uploading thumbnail to Cloudinary...');
    const uploadResult = await uploadFile(thumbnailPath, {
      folder: 'jam-thumbnails',
      publicId: `thumb_${recordingId}`,
      resourceType: 'image',
      tags: ['thumbnail', `rec_${recordingId}`],
      overwrite: true,
    });

    await job.updateProgress(90);

    // ── 5. Update recording with thumbnail URL ────────────────────────
    await prisma.recording.update({
      where: { id: recordingId },
      data: {
        thumbnailUrl: uploadResult.secureUrl,
        updatedAt: new Date(),
      },
    });

    await job.updateProgress(100);
    log.info('Thumbnail generation complete', { thumbnailUrl: uploadResult.secureUrl });
  } catch (error) {
    log.error('Thumbnail generation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't throw — thumbnail failure is non-critical; the recording is already READY
    // Just log and move on
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    log.debug('Temp directory cleaned up');
  }
}

/** Create and start the thumbnail worker */
export function createThumbnailWorker(connection: ConnectionOptions): Worker<ThumbnailJobData> {
  const worker = new Worker<ThumbnailJobData>(QUEUE_NAME, processThumbnailJob, {
    connection,
    concurrency: 5,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  });

  worker.on('active', (job) => {
    logger.info(`[ThumbnailWorker] Job started`, {
      jobId: job.id,
      recordingId: job.data.recordingId,
    });
  });

  worker.on('completed', (job) => {
    logger.info(`[ThumbnailWorker] Job completed`, {
      jobId: job.id,
      recordingId: job.data.recordingId,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error(`[ThumbnailWorker] Job failed`, {
      jobId: job?.id,
      error: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(`[ThumbnailWorker] Worker error`, { error: err.message });
  });

  logger.info(`[ThumbnailWorker] Started`, { queue: QUEUE_NAME });

  return worker;
}
