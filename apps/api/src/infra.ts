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
import { env } from './config/env.ts';
import { useRedisState } from './state/index.ts';
import { useRedisCache } from './cache/index.ts';
import { configureOutboxEventBus } from './plugins/events.ts';
import { DbJobLease, initJobs } from './jobs/index.ts';
import type { LeaseDb } from './jobs/lease.ts';
import { getPrisma } from './plugins/prisma.ts';
import { resolveStorageDriver, type StorageExtensionRuntime } from './storage/provider-router.ts';

/** Redis client type derived from the shared factory (no direct ioredis dep). */
type RedisClient = Awaited<ReturnType<typeof getRedis>>;

let infra: InfraConfig | null = null;
let storage: StorageDriver | null = null;
/** The plugin runtime that may provide a storage backend (set after app init). */
let storageRuntime: StorageExtensionRuntime | null = null;

/** Validated infrastructure config (throws on invalid production config). */
export function getInfraConfig(): InfraConfig {
  if (!infra) {
    infra = readInfraConfig({ env: process.env, dataDir: resolveStackPanelDataDir() });
  }
  return infra;
}

/** The env-configured storage driver, without plugin-provided backends. */
function createFallbackStorage(): StorageDriver {
  return createStorageDriver(getInfraConfig().storage);
}

/**
 * The process-wide storage driver.
 *
 * When a `storage.provider` extension is registered the driver is a router over
 * the plugin backend; otherwise it is the env-configured driver. Reads always
 * fall back to the env driver so switching backends never strands old objects.
 */
export function getStorage(): StorageDriver {
  if (!storage) storage = createFallbackStorage();
  return storage;
}

/**
 * Bind the plugin runtime so a `storage.provider` implementation can become the
 * process-wide storage backend. Called by the plugin host once the runtime
 * exists; the driver is re-resolved on every activate/deactivate via
 * {@link refreshStorageDriver}.
 */
export function setStorageRuntime(runtime: StorageExtensionRuntime): void {
  storageRuntime = runtime;
  refreshStorageDriver();
}

/** Re-resolve the storage driver from the current runtime (idempotent). */
export function refreshStorageDriver(): void {
  const fallback = createFallbackStorage();
  storage = storageRuntime ? resolveStorageDriver(storageRuntime, fallback) : fallback;
  // A plugin backend that just became active may need one-time provisioning
  // (e.g. create its bucket). `initInfra` runs before the plugin host binds the
  // runtime, so provisioning cannot live only there. The env fallback is
  // already provisioned in `initInfra`, so we only provision a provider here.
  if (storage.kind === 'provider') void provisionStorage(storage);
}

/** Best-effort provisioning of the active driver's backing store. Never throws. */
async function provisionStorage(driver: StorageDriver): Promise<void> {
  if (!('ensureBucket' in driver)) return;
  try {
    await (driver as unknown as { ensureBucket?: () => Promise<void> }).ensureBucket?.();
  } catch (error) {
    console.warn(`[infra] 存储后端初始化失败（首写时仍会重试）：${String(error)}`);
  }
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
  if (redis) {
    useRedisState(redis);
    // ADR-0022 D3: the read cache learns about cross-replica invalidation here.
    await useRedisCache(redis);
  }
  // S5: bind the durable outbox; the relay covers crash recovery and Redis
  // Pub/Sub covers cross-replica delivery (Redis absent -> local-only relay).
  configureOutboxEventBus({
    db: getPrisma() as unknown as Parameters<typeof configureOutboxEventBus>[0]['db'],
    redis,
    production: getInfraConfig().production,
    ...(env.STACKPANEL_INSTANCE_ID ? { instanceId: env.STACKPANEL_INSTANCE_ID } : {}),
    replayWindowMs: env.STACKPANEL_OUTBOX_REPLAY_WINDOW_MS,
    logger: {
      warn: (message) => console.warn(message),
      info: (message) => console.info(message),
    },
  });
  // S6: attach the job backend (BullMQ with Redis, in-process otherwise) and
  // start consuming. Kernel sweeps were registered synchronously in buildApp().
  await initJobs({
    redisUrl: getInfraConfig().redisUrl ?? null,
    // 进程内后端靠数据库租约保证「一个 tick 只有一个副本执行」；BullMQ 下不用。
    lease: new DbJobLease(getPrisma() as unknown as LeaseDb),
    logger: {
      warn: (message) => console.warn(message),
      info: (message) => console.info(message),
    },
  });
  const driver = getStorage();
  await provisionStorage(driver);
}
