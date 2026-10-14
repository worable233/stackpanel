import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolConfig } from 'pg';
import { PrismaClient } from './generated/prisma/client.ts';

export { PrismaClient } from './generated/prisma/client.ts';
export * from './generated/prisma/client.ts';
export * from './generated/prisma/enums.ts';

export {
  InfraConfigError,
  readInfraConfig,
  type InfraConfig,
  type LocalStorageConfig,
  type S3StorageConfig,
  type StorageConfig,
  type StorageDriverKind,
} from './config.ts';
export {
  assertSafeStorageKey,
  contentTypeForKey,
  createStorageDriver,
  LocalDiskDriver,
  S3Driver,
  type PutObjectOptions,
  type StorageDriver,
  type StorageObjectStat,
} from './storage/index.ts';
export { closeRedis, getRedis, peekRedis, pingRedis, type RedisClient } from './redis.ts';

/** True when the connection string points to a PostgreSQL server. */
function isPostgresUrl(url: string): boolean {
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

/**
 * Explicit connection-pool budget for one Prisma client (= one process).
 *
 * These are deliberately *not* left to the `pg` defaults. The previous code
 * passed a bare connection string, which resolved to `max: 10` and — worse —
 * no acquisition timeout at all, so a saturated pool made requests wait
 * forever instead of failing. Two pools also stack: an API replica sizes its
 * pool, Postgres sizes `max_connections`, and the product of replicas × max
 * must stay under it.
 */
export interface PrismaPoolOptions {
  /** Max connections held by this process. Default 10 (the historical `pg` default). */
  max?: number;
  /** How long to wait for a free connection before failing. Default 10s. */
  connectionTimeoutMillis?: number;
  /** How long an idle connection is kept. Default 30s (`pg` default). */
  idleTimeoutMillis?: number;
  /** Server-side per-statement timeout, guarding against runaway queries. Default 30s. */
  statementTimeoutMillis?: number;
  /** Applied as `application_name`, so `pg_stat_activity` can attribute connections. */
  applicationName?: string;
}

const POOL_DEFAULTS = {
  max: 10,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statementTimeoutMillis: 30_000,
} as const;

/**
 * Create a Prisma client connected to PostgreSQL.
 *
 * PostgreSQL is the only supported engine (ADR-0019). The `pg` driver adapter
 * is used so the schema needs no bundled query engine binary and DDL can run
 * inside transactions (the Extension engine relies on rollbackable DDL).
 *
 * The pool is configured explicitly (see {@link PrismaPoolOptions}) so that
 * saturation fails fast with a driver error instead of hanging, and so the
 * per-process budget is a decision rather than an accident of `pg` defaults.
 */
export function createPrismaClient(
  connectionString: string,
  pool: PrismaPoolOptions = {},
): PrismaClient {
  if (!isPostgresUrl(connectionString)) {
    throw new Error(
      `不支持的数据库连接串：${connectionString}。本版本仅支持 PostgreSQL（postgres:// 或 postgresql://）。`,
    );
  }
  const max = pool.max ?? POOL_DEFAULTS.max;
  const connectionTimeoutMillis =
    pool.connectionTimeoutMillis ?? POOL_DEFAULTS.connectionTimeoutMillis;
  const idleTimeoutMillis = pool.idleTimeoutMillis ?? POOL_DEFAULTS.idleTimeoutMillis;
  const statementTimeoutMillis =
    pool.statementTimeoutMillis ?? POOL_DEFAULTS.statementTimeoutMillis;

  const config: PoolConfig = {
    connectionString,
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    // `pg` forwards these as libpq startup parameters. A 0 value disables the
    // corresponding timeout, so only set them when positive.
    ...(statementTimeoutMillis > 0 ? { statement_timeout: statementTimeoutMillis } : {}),
    ...(pool.applicationName ? { application_name: pool.applicationName } : {}),
  };

  const adapter = new PrismaPg(config);
  return new PrismaClient({ adapter });
}

/**
 * Probe reachability with a short-lived connection, independent of any
 * Prisma pool. Returns false when the database cannot be reached.
 */
export async function probeDatabase(connectionString: string): Promise<boolean> {
  if (!isPostgresUrl(connectionString)) return false;
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 4000, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
