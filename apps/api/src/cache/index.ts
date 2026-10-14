/**
 * Kernel {@link CacheService} singleton (ADR-0022 D3 / P10–P12).
 *
 * Same shape as `state/index.ts`: `buildApp()` is synchronous and cannot await
 * the Redis connection, so plugins receive one stable {@link DataCache}
 * instance that starts life without a broadcast subscriber and gains one when
 * `initInfra()` connects Redis. Plugins read `ctx.cache` per activation, so no
 * consumer changes when the backend becomes cluster-aware.
 */
import type { CacheService, CacheReadOptions } from '@stackpanel/sdk';
import type { RedisClient } from '@stackpanel/db';
import { DataCache, cacheInvalidateChannel, type DataCacheLogger } from './data-cache.ts';

let cache: DataCache | null = null;

/** The process-wide data cache. */
export function getDataCache(): DataCache {
  if (!cache) cache = new DataCache({ logger: consoleBackedLogger() });
  return cache;
}

/** `ctx.cache` implementation: the singleton, narrowed to the plugin contract. */
export function getCacheService(): CacheService {
  const instance = getDataCache();
  return {
    remember: <T>(key: string, options: CacheReadOptions, loader: () => Promise<T>) =>
      instance.remember<T>(key, options, loader),
    invalidate: (kind: string) => instance.invalidateKinds([kind]),
  };
}

/**
 * Attach the cross-replica invalidation channel. Called from `initInfra()` once
 * Redis is connected; without Redis the cache stays process-local and the
 * per-entry TTL remains the only staleness bound.
 */
export async function useRedisCache(redis: RedisClient): Promise<void> {
  const instance = getDataCache();
  instance.attachRedis(redis);
  await instance.start();
}

/**
 * Host-side handler for the isolated bridge's cache capabilities.
 *
 * The worker cannot hand a loader across IPC, so it splits a read into
 * `cache.peek` → (plugin runs the loader) → `cache.put`. Storage, bounds and
 * cross-replica invalidation therefore stay inside the kernel (ADR-0022 D3);
 * the plugin only ever runs its own data access.
 *
 * Returns `undefined` for `put`/`invalidate` (nothing to send back).
 */
export function dispatchCacheCapability(capability: string, args: unknown): unknown {
  const cache = getDataCache();
  const record = (args ?? {}) as { key?: unknown; value?: unknown; ttlMs?: unknown; kinds?: unknown; kind?: unknown };
  const kinds = Array.isArray(record.kinds) ? record.kinds.map(String) : [];
  if (capability === 'cache.peek') {
    return cache.peek(String(record.key));
  }
  if (capability === 'cache.put') {
    cache.put(String(record.key), record.value, {
      ttlMs: Number(record.ttlMs),
      kinds: kinds.length > 0 ? kinds : [String(record.kind)],
    });
    return undefined;
  }
  if (capability === 'cache.invalidate') {
    void cache.invalidateKinds(kinds.length > 0 ? kinds : [String(record.kind)]);
    return undefined;
  }
  throw new Error(`未知缓存能力：${capability}`);
}

/** Channel name (exported for tests and the metrics surface). */
export { cacheInvalidateChannel };

function consoleBackedLogger(): DataCacheLogger {
  return {
    warn: (message: string) => console.warn(message),
  };
}

/** Test hook: drop the singleton so suites do not share cached values. */
export function resetDataCache(): void {
  cache?.stop();
  cache = null;
}
