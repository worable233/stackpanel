/**
 * Kernel infrastructure singletons (Redis + object storage).
 *
 * Configuration is validated once, on first use, so a misconfigured production
 * deployment fails fast with a clear message (ADR-0017). Development may omit
 * `REDIS_URL` (in-process fallbacks) and may use the local-disk storage driver.
 */
import {
  createStorageDriver,
  getRedis,
  readInfraConfig,
  type InfraConfig,
  type StorageDriver,
} from '@stackpanel/db';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { useRedisState } from './state/index.ts';
import { configureOutboxEventBus } from './plugins/events.ts';
import { initJobs } from './jobs/index.ts';
import { getPrisma } from './plugins/prisma.ts';

/** Redis client type derived from the shared factory (no direct ioredis dep). */
type RedisClient = Awaited<ReturnType<typeof getRedis>>;

let infra: InfraConfig | null = null;
let storage: StorageDriver | null = null;

/** Validated infrastructure config (throws on invalid production config). */
export function getInfraConfig(): InfraConfig {
  if (!infra) {
    infra = readInfraConfig({ env: process.env, dataDir: resolveStackPanelDataDir() });
  }
  return infra;
}

/** The process-wide storage driver. */
export function getStorage(): StorageDriver {
  if (!storage) {
    storage = createStorageDriver(getInfraConfig().storage);
  }
  return storage;
}

/**
 * Connect the shared Redis client when `REDIS_URL` is configured.
 * Returns null in development when Redis is absent.
 */
export async function initRedis(): Promise<RedisClient | null> {
  const url = getInfraConfig().redisUrl;
  if (!url) return null;
  return getRedis(url);
}

/**
 * Initialise infrastructure at startup: validate config, connect Redis, and
 * make sure the object-storage bucket exists. Idempotent.
 */
export async function initInfra(): Promise<void> {
  getInfraConfig();
  const redis = await initRedis();
  // S5.5: share kernel state across replicas. Development without Redis keeps
  // the in-process implementation.
  if (redis) useRedisState(redis);
  // S5: bind the durable outbox; the relay covers crash recovery and Redis
  // Pub/Sub covers cross-replica delivery (Redis absent -> local-only relay).
  configureOutboxEventBus({
    db: getPrisma() as unknown as Parameters<typeof configureOutboxEventBus>[0]['db'],
    redis,
    production: getInfraConfig().production,
    logger: {
      warn: (message) => console.warn(message),
      info: (message) => console.info(message),
    },
  });
  // S6: attach the job backend (BullMQ with Redis, in-process otherwise) and
  // start consuming. Kernel sweeps were registered synchronously in buildApp().
  await initJobs({
    redisUrl: getInfraConfig().redisUrl ?? null,
    logger: {
      warn: (message) => console.warn(message),
      info: (message) => console.info(message),
    },
  });
  const driver = getStorage();
  if (driver.kind === 's3' && 'ensureBucket' in driver) {
    await (driver as unknown as { ensureBucket(): Promise<void> }).ensureBucket();
  }
}
