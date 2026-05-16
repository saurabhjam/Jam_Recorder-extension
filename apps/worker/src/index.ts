import 'dotenv/config';
import http from 'http';
import { promises as fs } from 'fs';
import type { Worker } from 'bullmq';
import { getRedis, closeRedis, createRedisConnection } from './lib/redis';
import { prisma, disconnectPrisma } from './lib/prisma';
import { createVideoWorker } from './workers/video.worker';
import { createThumbnailWorker } from './workers/thumbnail.worker';
import { createNotificationWorker } from './workers/notification.worker';
import { checkFfmpegAvailable } from './processors/ffmpeg.processor';
import { logger } from './utils/logger';

// ─── Config ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.WORKER_HEALTH_PORT ?? '3002');
const TEMP_DIR = process.env.TEMP_DIR ?? '/tmp/jam-worker';

// ─── Global worker registry ────────────────────────────────────────────────

const workers: Worker[] = [];

// ─── Health check HTTP server ──────────────────────────────────────────────

function createHealthServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/') {
      try {
        // Check Redis
        const redis = getRedis();
        await redis.ping();

        // Check DB
        await prisma.$queryRaw`SELECT 1`;

        const healthPayload = {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          workers: workers.map((w) => ({
            name: w.name,
            running: !w.closing,
          })),
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(healthPayload, null, 2));
      } catch (err) {
        const errorPayload = {
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          error: err instanceof Error ? err.message : 'Unknown error',
        };
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorPayload));
      }
    } else if (req.url === '/metrics') {
      // Simple Prometheus-like metrics
      const metrics = [
        `# HELP worker_uptime_seconds Time the worker has been running`,
        `# TYPE worker_uptime_seconds gauge`,
        `worker_uptime_seconds ${process.uptime()}`,
        ``,
        `# HELP worker_memory_heap_used_bytes Memory heap used`,
        `# TYPE worker_memory_heap_used_bytes gauge`,
        `worker_memory_heap_used_bytes ${process.memoryUsage().heapUsed}`,
        ``,
        `# HELP worker_count Number of active workers`,
        `# TYPE worker_count gauge`,
        `worker_count ${workers.length}`,
      ].join('\n');

      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metrics);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return server;
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal} — shutting down gracefully...`);

  // Give workers time to finish current jobs (30 second timeout)
  const shutdownTimeout = setTimeout(() => {
    logger.error('Shutdown timeout reached, forcing exit');
    process.exit(1);
  }, 30_000);

  try {
    // Close all workers
    logger.info(`Closing ${workers.length} worker(s)...`);
    await Promise.all(workers.map((w) => w.close()));
    logger.info('All workers closed');

    // Close Redis
    await closeRedis();

    // Disconnect Prisma
    await disconnectPrisma();

    clearTimeout(shutdownTimeout);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { error: (err as Error).message });
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  logger.info('='.repeat(50));
  logger.info('Jam Worker starting up...');
  logger.info('='.repeat(50));

  // ── 1. Verify FFmpeg is available ────────────────────────────────────
  const ffmpegOk = await checkFfmpegAvailable();
  if (!ffmpegOk) {
    logger.warn('FFmpeg not found — video processing will fail. Install FFmpeg or set FFMPEG_PATH');
  } else {
    logger.info('FFmpeg check passed');
  }

  // ── 2. Ensure temp directory exists ──────────────────────────────────
  await fs.mkdir(TEMP_DIR, { recursive: true });
  logger.info(`Temp directory ready: ${TEMP_DIR}`);

  // ── 3. Connect to Redis ───────────────────────────────────────────────
  const redis = getRedis();
  await redis.ping();
  logger.info('Redis connection verified');

  // ── 4. Connect to Postgres ────────────────────────────────────────────
  await prisma.$queryRaw`SELECT 1`;
  logger.info('Database connection verified');

  // ── 5. Create BullMQ connection options ───────────────────────────────
  // BullMQ requires separate connection instances per worker
  const videoConnection = createRedisConnection();
  const thumbnailConnection = createRedisConnection();
  const notificationConnection = createRedisConnection();

  // ── 6. Start workers ──────────────────────────────────────────────────
  const videoWorker = createVideoWorker(videoConnection);
  const thumbnailWorker = createThumbnailWorker(thumbnailConnection);
  const notificationWorker = createNotificationWorker(notificationConnection);

  workers.push(videoWorker, thumbnailWorker, notificationWorker);
  logger.info(`Started ${workers.length} worker(s)`);

  // ── 7. Start health check HTTP server ─────────────────────────────────
  const healthServer = createHealthServer();
  healthServer.listen(PORT, () => {
    logger.info(`Health check server listening on http://0.0.0.0:${PORT}`);
    logger.info(`  GET /health  — health status`);
    logger.info(`  GET /metrics — Prometheus metrics`);
  });

  // ── 8. Register signal handlers ───────────────────────────────────────
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  logger.info('='.repeat(50));
  logger.info('Jam Worker is ready and processing jobs');
  logger.info('='.repeat(50));
}

// ─── Entry point ───────────────────────────────────────────────────────────

bootstrap().catch((err) => {
  logger.error('Worker failed to start', {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
