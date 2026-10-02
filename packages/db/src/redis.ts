/**
 * Redis client factory (ADR-0017).
 *
 * A single shared connection is created from `REDIS_URL`. In development the
 * URL may be absent, in which case {@link getRedis} returns null and callers
 * fall back to an in-process implementation. Production requires `REDIS_URL`
 * (enforced by `readInfraConfig`).
 *
 * Compatibility note: this module imports `ioredis` lazily so the kernel can
 * boot in development without a Redis server or the dependency being reachable.
 */
import type { Redis } from 'ioredis';

/**
 * The shared Redis client type, re-exported so consumers (kernel state/events,
 * rate limiting) can annotate their own modules without a direct `ioredis`
 * dependency.
 */
export type RedisClient = Redis;

let client: Redis | null = null;
let configuredUrl: string | null = null;

/** Create (or reuse) the shared Redis client. */
export async function getRedis(url: string): Promise<Redis> {
  if (client && configuredUrl === url) return client;
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
  const { default: RedisCtor } = await import('ioredis');
  client = new RedisCtor(url, {
    // Fail fast on startup rather than queueing commands forever.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    lazyConnect: false,
  });
  configuredUrl = url;
  return client;
}

/** The shared client, or null when Redis is not configured/initialised. */
export function peekRedis(): Redis | null {
  return client;
}

/** Reachability probe used by readiness checks. Returns false when absent. */
export async function pingRedis(): Promise<boolean> {
  if (!client) return false;
  try {
    const pong = await client.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/** Close the shared client (tests / shutdown). */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => undefined);
  client = null;
  configuredUrl = null;
}
