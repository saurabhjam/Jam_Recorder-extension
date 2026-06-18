// BullMQ / Redis queues removed.
// Recordings go directly to the external API in upload.service.ts — no queue needed.

import type {
  AnalyticsJob,
  NotificationJob,
  ThumbnailJob,
  VideoProcessingJob,
} from '@snaptrace/types';

// Stub queue object (used by the retry endpoint in routes/recordings.ts)
export const videoProcessingQueue = {
  getJob: async (_jobId: string) => null,
} as const;

export async function queueVideoProcessing(_data: VideoProcessingJob): Promise<void> {}

export async function queueThumbnailGeneration(_data: ThumbnailJob): Promise<void> {}

export async function queueAnalyticsEvent(_data: AnalyticsJob): Promise<void> {}

export async function queueNotification(_data: NotificationJob): Promise<void> {}

export async function getQueueHealth(): Promise<Record<string, object>> {
  return {};
}
