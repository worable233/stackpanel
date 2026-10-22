/**
 * 自举预检的深度探测（审计 R8）。
 *
 * 这些探测需要 `pg` / `ioredis` / `@aws-sdk/client-s3`，它们由 `@stackpanel/db`
 * 持有（内核其它部分不允许直接依赖）。放在这里而不是 API 里，有两个原因：
 *
 * 1. **依赖边界**：`apps/api` 的 package.json 没有这三个包，直接 import 会
 *    在构建产物里变成未声明依赖，`collectClosure` 也会漏收。
 * 2. **口径一致**：与内核运行期使用同一套客户端配置（连接超时、TLS 默认值），
 *    避免"探测能过、运行期不过"。
 *
 * 与 `probeDatabase()`（只做 SELECT 1 的轻量探活）不同，这里的探测用于
 * **决定是否允许初始化一个新实例**，因此必须验证权限与既有状态。
 * 两者不能互相替代，也不要合并。
 */

import { randomBytes } from 'node:crypto';
import { S3Client, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Pool } from 'pg';

/** 探测失败分类；与 `@stackpanel/spec` 的 `BootstrapProbeFailure` 对应。 */
export type InfraProbeFailure =
  | 'database_unreachable'
  | 'database_version_unsupported'
  | 'database_permission_denied'
  | 'database_schema_conflict'
  | 'database_migration_state_invalid'
  | 'redis_unreachable'
  | 'redis_permission_denied'
  | 'storage_unreachable'
  | 'storage_permission_denied'
  | 'storage_write_failed'
  | 'invalid_config';

export interface InfraProbeResult {
  ok: boolean;
  failure?: InfraProbeFailure;
  /** 内部诊断：只写日志，**不得**直接回显给浏览器。 */
  detail?: string;
}

/** 探测预算；调用方也可传入更小的值。 */
export interface ProbeBudget {
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * PostgreSQL 深度探测。
 *
 * 验证：能连上 / 版本 >= 13 / 有 DDL 权限 / 既有迁移状态健康 /
 * 非空未知库拒绝初始化。
 */
export async function probePostgresForBootstrap(
  connectionString: string,
  budget: ProbeBudget = {},
): Promise<InfraProbeResult> {
  const timeout = budget.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  if (!connectionString.startsWith('postgres://') && !connectionString.startsWith('postgresql://')) {
    return { ok: false, failure: 'invalid_config', detail: '不是合法的 postgresql:// URL' };
  }

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: timeout,
    max: 1,
    application_name: 'stackpanel-bootstrap-probe',
  });

  try {
    const client = await pool.connect();
    try {
      await client.query(`SET statement_timeout = ${Math.max(1000, timeout)}`);

      const versionResult = await client.query<{ server_version_num: string }>(
        'SHOW server_version_num',
      );
      const versionNum = Number(versionResult.rows[0]?.server_version_num ?? 0);
      if (!Number.isFinite(versionNum) || versionNum < 130000) {
        return {
          ok: false,
          failure: 'database_version_unsupported',
          detail: `PostgreSQL 版本过低：${versionNum}`,
        };
      }

      const canCreate = await client.query<{ can_create: boolean }>(
        `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create`,
      );
      if (!canCreate.rows[0]?.can_create) {
        return {
          ok: false,
          failure: 'database_permission_denied',
          detail: '当前用户对 public schema 没有 CREATE 权限',
        };
      }

      const migrationsTable = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_name = '_prisma_migrations'
         ) AS exists`,
      );

      if (migrationsTable.rows[0]?.exists === true) {
        const failed = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "_prisma_migrations"
           WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
        );
        if (Number(failed.rows[0]?.count ?? '0') > 0) {
          return {
            ok: false,
            failure: 'database_migration_state_invalid',
            detail: '存在未完成的历史迁移记录，需人工检查',
          };
        }
      } else {
        const objects = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM information_schema.tables
           WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`,
        );
        if (Number(objects.rows[0]?.count ?? '0') > 0) {
          return {
            ok: false,
            failure: 'database_schema_conflict',
            detail: '目标数据库非空且不是 StackPanel 实例，拒绝自动初始化',
          };
        }
      }

      return { ok: true };
    } finally {
      client.release();
    }
  } catch (error) {
    return { ok: false, ...classifyPostgresError(error) };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Redis 深度探测。
 *
 * 用专用随机 key 做 set/get/del + TTL：只 PING 会放过 ACL 禁用写、
 * 或用错 DB 编号的情况。客户端参数与内核 `getRedis()` 对齐
 * （`maxRetriesPerRequest: 2`），但**不用共享单例**，避免污染运行期连接。
 */
export async function probeRedisForBootstrap(
  redisUrl: string,
  budget: ProbeBudget = {},
): Promise<InfraProbeResult> {
  const timeout = budget.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  if (!redisUrl.startsWith('redis://') && !redisUrl.startsWith('rediss://')) {
    return { ok: false, failure: 'invalid_config', detail: '不是合法的 redis:// URL' };
  }

  const { default: RedisCtor } = await import('ioredis');
  const client = new RedisCtor(redisUrl, {
    lazyConnect: true,
    connectTimeout: timeout,
    commandTimeout: timeout,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // 探测只尝试一次；不要后台无限重连。
    retryStrategy: () => null,
  });

  const key = `stackpanel:bootstrap-probe:${randomBytes(12).toString('hex')}`;
  try {
    await client.connect();
    await client.set(key, 'ok', 'PX', 30_000);
    const value = await client.get(key);
    if (value !== 'ok') {
      return { ok: false, failure: 'redis_unreachable', detail: '写入后读回不一致' };
    }
    await client.del(key);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const permission = /NOAUTH|NOPERM|WRONGPASS|invalid password/i.test(message);
    return {
      ok: false,
      failure: permission ? 'redis_permission_denied' : 'redis_unreachable',
      detail: message,
    };
  } finally {
    // del 可能在上面已执行；再试一次是幂等的，失败忽略（TTL 兜底）。
    await client.del(key).catch(() => undefined);
    await client.quit().catch(() => client.disconnect());
  }
}

export interface S3ProbeInput {
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/**
 * S3 深度探测。
 *
 * 用私有随机前缀做 put → get → delete 三段验证。
 * 只 `HeadBucket` 会放过"只读凭据"——而媒体上传是核心功能。
 * 清理失败要单独报错：残留对象说明权限模型与预期不符。
 */
export async function probeS3ForBootstrap(
  input: S3ProbeInput,
  budget: ProbeBudget = {},
): Promise<InfraProbeResult> {
  const timeout = budget.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const client = new S3Client({
    region: input.region ?? 'us-east-1',
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    forcePathStyle: input.forcePathStyle ?? true,
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    },
    requestHandler: { requestTimeout: timeout, connectionTimeout: timeout },
  });

  const prefix = `stackpanel-bootstrap-probe/${randomBytes(12).toString('hex')}`;
  const key = `${prefix}/probe.txt`;
  const body = `stackpanel bootstrap probe ${new Date().toISOString()}`;

  try {
    await client.send(new HeadBucketCommand({ Bucket: input.bucket }));

    await client.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: key,
        Body: body,
        ContentType: 'text/plain',
        // 私有：探测对象不应泄漏到公网。
        ACL: 'private',
      }),
    );

    const read = await client.send(new GetObjectCommand({ Bucket: input.bucket, Key: key }));
    const readBody = await read.Body?.transformToString();
    if (readBody !== body) {
      return { ok: false, failure: 'storage_write_failed', detail: '写入后读回不一致' };
    }

    try {
      await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: key }));
    } catch (error) {
      return {
        ok: false,
        failure: 'storage_write_failed',
        detail: `探测对象清理失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, ...classifyS3Error(error) };
  } finally {
    client.destroy();
  }
}

function classifyPostgresError(error: unknown): { failure: InfraProbeFailure; detail: string } {
  const code = (error as { code?: string }).code ?? '';
  const message = error instanceof Error ? error.message : String(error);
  if (code === '28P01' || code === '28000' || /password authentication failed/i.test(message)) {
    return { failure: 'database_permission_denied', detail: message };
  }
  if (code === '42501') return { failure: 'database_permission_denied', detail: message };
  if (code === '3D000') return { failure: 'database_unreachable', detail: '数据库不存在' };
  if (code === '42P01' || code === '42703') {
    return { failure: 'database_schema_conflict', detail: message };
  }
  if (/timeout|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET/i.test(message)) {
    return { failure: 'database_unreachable', detail: message };
  }
  return { failure: 'database_unreachable', detail: message };
}

function classifyS3Error(error: unknown): { failure: InfraProbeFailure; detail: string } {
  const name = (error as { name?: string }).name ?? '';
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const detail = error instanceof Error ? error.message : String(error);
  if (name === 'AccessDenied' || name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    return { failure: 'storage_permission_denied', detail };
  }
  if (status === 403) return { failure: 'storage_permission_denied', detail };
  if (name === 'NoSuchBucket' || status === 404) {
    return { failure: 'storage_unreachable', detail: 'bucket 不存在' };
  }
  return { failure: 'storage_unreachable', detail };
}
