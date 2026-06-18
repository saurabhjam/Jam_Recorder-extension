// Redis removed — all cache operations are no-ops.
// Upload sessions now live in an in-memory Map (see upload.service.ts).

export function getRedisClient(): null {
  return null;
}

export async function connectRedis(): Promise<void> {}

export async function disconnectRedis(): Promise<void> {}

export async function cacheGet<T>(_key: string): Promise<T | null> {
  return null;
}

export async function cacheSet<T>(_key: string, _value: T, _ttlSeconds?: number): Promise<void> {}

export async function cacheDel(_key: string): Promise<void> {}

export async function cacheDelPattern(_pattern: string): Promise<void> {}

export const cacheKeys = {
  recording: (id: string) => `recording:${id}`,
  recordingPublic: (shareId: string) => `recording:public:${shareId}`,
  user: (id: string) => `user:${id}`,
  team: (id: string) => `team:${id}`,
  shareLink: (token: string) => `share:${token}`,
  uploadProgress: (recordingId: string) => `upload:progress:${recordingId}`,
};

export const redis = null;
export default redis;
