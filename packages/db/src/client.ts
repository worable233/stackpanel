import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
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
 * Create a Prisma client connected to PostgreSQL.
 *
 * PostgreSQL is the only supported engine (ADR-0019). The `pg` driver adapter
 * is used so the schema needs no bundled query engine binary and DDL can run
 * inside transactions (the Extension engine relies on rollbackable DDL).
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  if (!isPostgresUrl(connectionString)) {
    throw new Error(
      `不支持的数据库连接串：${connectionString}。本版本仅支持 PostgreSQL（postgres:// 或 postgresql://）。`,
    );
  }
  const adapter = new PrismaPg({ connectionString });
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
