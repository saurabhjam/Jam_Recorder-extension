import { Queue, type ConnectionOptions } from 'bullmq';

import { config } from '../config';
import { getRedisClient } from '../lib/redis';
import type {
  AnalyticsJob,
  NotificationJob,
  ThumbnailJob,
  VideoProcessingJob,
} from '@snaptrace/types';
import { QUEUE_NAMES } from '@snaptrace/config';

// ============================================================
// BullMQ Connection
// ============================================================

function getConnection(): ConnectionOptions {
  const url = new URL(config.redis.url);
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    password: url.password || undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
  };
}

const connection = getConnection();

// ============================================================
// Queue Definitions
// ============================================================

export const videoProcessingQueue = new Queue<VideoProcessingJob>(QUEUE_NAMES.VIDEO_PROCESSING, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 100,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  },
});

export const thumbnailQueue = new Queue<ThumbnailJob>(QUEUE_NAMES.THUMBNAIL_GENERATION, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: { age: 24 * 3600, count: 200 },
    removeOnFail: { age: 3 * 24 * 3600 },
  },
});

export const analyticsQueue = new Queue<AnalyticsJob>(QUEUE_NAMES.ANALYTICS, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 1000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600 },
  },
});

export const notificationQueue = new Queue<NotificationJob>(QUEUE_NAMES.NOTIFICATIONS, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 24 * 3600, count: 500 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

// ============================================================
// Job Helpers
// ============================================================

/**
 * Queue a video processing job after all chunks are uploaded.
 */
export async function queueVideoProcessing(data: VideoProcessingJob): Promise<void> {
  await videoProcessingQueue.add(`process-${data.recordingId}`, data, {
    jobId: `video-${data.recordingId}`, // Deduplicate by recording ID
  });
}

/**
 * Queue a thumbnail generation job.
 */
export async function queueThumbnailGeneration(data: ThumbnailJob): Promise<void> {
  await thumbnailQueue.add(`thumbnail-${data.recordingId}`, data, {
    jobId: `thumbnail-${data.recordingId}`,
  });
}

/**
 * Queue an analytics event (fire and forget).
 */
export async function queueAnalyticsEvent(data: AnalyticsJob): Promise<void> {
  await analyticsQueue.add(`analytics-${Date.now()}`, data);
}

/**
 * Queue a notification to be sent to a user.
 */
export async function queueNotification(data: NotificationJob): Promise<void> {
  await notificationQueue.add(`notification-${Date.now()}`, data);
}

// ============================================================
// Queue Health Check
// ============================================================

export async function getQueueHealth(): Promise<Record<string, object>> {
  const queues = [
    { name: QUEUE_NAMES.VIDEO_PROCESSING, queue: videoProcessingQueue },
    { name: QUEUE_NAMES.THUMBNAIL_GENERATION, queue: thumbnailQueue },
    { name: QUEUE_NAMES.ANALYTICS, queue: analyticsQueue },
    { name: QUEUE_NAMES.NOTIFICATIONS, queue: notificationQueue },
  ];

  const health: Record<string, object> = {};

  await Promise.all(
    queues.map(async ({ name, queue }) => {
      const [waiting, active, completed, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
      ]);
      health[name] = { waiting, active, completed, failed };
    }),
  );

  return health;
}
