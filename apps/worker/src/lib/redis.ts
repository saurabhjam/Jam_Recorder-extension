import Redis from 'ioredis';
import { logger } from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let redisClient: Redis | null = null;

/** Get or create the Redis singleton */
export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,
      lazyConnect: false,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 5000);
        logger.warn(`Redis reconnecting... attempt ${times}, waiting ${delay}ms`);
        return delay;
      },
    });

    redisClient.on('connect', () => {
      logger.info('Redis connected');
    });

    redisClient.on('error', (err) => {
      logger.error('Redis error', { error: err.message });
    });

    redisClient.on('close', () => {
      logger.warn('Redis connection closed');
    });

    redisClient.on('reconnecting', () => {
      logger.warn('Redis reconnecting...');
    });
  }

  return redisClient;
}

/** Create a new Redis connection (needed for BullMQ subscribers) */
export function createRedisConnection(): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}

/** Close the Redis connection gracefully */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  }
}
