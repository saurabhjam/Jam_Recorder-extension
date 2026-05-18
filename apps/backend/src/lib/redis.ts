import IORedis from 'ioredis';

import { config } from '../config';

let redisClient: IORedis | null = null;

export function getRedisClient(): IORedis {
  if (!redisClient) {
    redisClient = new IORedis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      reconnectOnError(err) {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
          return true;
        }
        return false;
      },
    });

    redisClient.on('connect', () => {
      console.info('[Redis] Connected');
    });

    redisClient.on('ready', () => {
      console.info('[Redis] Ready');
    });

    redisClient.on('error', (err: Error) => {
      console.error('[Redis] Error:', err.message);
    });

    redisClient.on('close', () => {
      console.warn('[Redis] Connection closed');
    });

    redisClient.on('reconnecting', () => {
      console.info('[Redis] Reconnecting...');
    });
  }

  return redisClient;
}

export async function connectRedis(): Promise<void> {
  const client = getRedisClient();
  await client.ping();
  console.info('[Redis] Connection verified');
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    console.info('[Redis] Disconnected');
  }
}

// Cache helpers
export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = getRedisClient();
  const value = await client.get(key);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
  const client = getRedisClient();
  // BigInt (e.g. Prisma's BigInt? size field) can't be JSON.stringify'd natively —
  // convert to string so the value round-trips safely through Redis.
  const serialized = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (ttlSeconds) {
    await client.setex(key, ttlSeconds, serialized);
  } else {
    await client.set(key, serialized);
  }
}

export async function cacheDel(key: string): Promise<void> {
  const client = getRedisClient();
  await client.del(key);
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  const client = getRedisClient();
  const keys = await client.keys(pattern);
  if (keys.length > 0) {
    await client.del(...keys);
  }
}

// Cache key builders
export const cacheKeys = {
  recording: (id: string) => `recording:${id}`,
  recordingPublic: (shareId: string) => `recording:public:${shareId}`,
  user: (id: string) => `user:${id}`,
  team: (id: string) => `team:${id}`,
  shareLink: (token: string) => `share:${token}`,
  uploadProgress: (recordingId: string) => `upload:progress:${recordingId}`,
};

export const redis = getRedisClient();
export default redis;
