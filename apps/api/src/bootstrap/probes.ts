/**
 * 基础设施预检（审计 R8）。
 *
 * 原则：**「连得上」不等于「能跑」。** 只做 `SELECT 1` / `PING` / `HeadBucket`
 * 会放过以下事故：
 * - 目标库是别人的业务库（非空、schema 不兼容）；
 * - 账号没有 DDL 权限，迁移执行到一半才失败；
 * - Redis ACL 允许 PING 但禁用了写，队列在运行期才炸；
 * - S3 只能列不能写，媒体上传在首小时后才发现。
 *
 * 实现分两层：
 * - 本文件负责**编排**（截止时间、顺序、配置解析、失败分类映射）；
 * - 真正的客户端调用在 `@stackpanel/db`（它才拥有 pg / ioredis / aws-sdk），
 *   这样探测与运行期用同一口径，也不会给 API 引入未声明的依赖。
 *
 * 三条硬约束：
 * 1. 整体有截止时间，子探测不叠加成分钟级；
 * 2. 每次探测用独立客户端，**不复用单例**，避免脏连接污染重试；
 * 3. 返回的 `detail` 只用于日志，**不得**直接回显给浏览器。
 */

import type { InfraProbeFailure } from '@stackpanel/db';
import {
  probePostgresForBootstrap,
  probeRedisForBootstrap,
  probeS3ForBootstrap,
} from '@stackpanel/db';
import type { BootstrapProbeFailure } from '@stackpanel/spec';

/** 单个探测的连接超时。 */
const PROBE_TIMEOUT_MS = 10_000;
/** 整个预检的总截止时间。 */
const TOTAL_DEADLINE_MS = 60_000;

export interface ProbeResult {
  ok: boolean;
  /** 失败分类（仅 `ok=false` 时有值）；不含原始错误细节。 */
  failure?: BootstrapProbeFailure;
  /** 内部诊断（只写日志，不回给浏览器）。调用方必须脱敏。 */
  detail?: string;
}

/** 已解析的存储配置。 */
export interface StorageTarget {
  driver: 'local' | 's3';
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export interface ProbeTargets {
  databaseUrl: string;
  redisUrl?: string;
  storage?: StorageTarget;
}

/** 整体预算：保证预检不会无限期挂起。 */
class Deadline {
  private readonly endsAt: number;
  constructor(budgetMs = TOTAL_DEADLINE_MS) {
    this.endsAt = Date.now() + budgetMs;
  }
  remaining(): number {
    return Math.max(0, this.endsAt - Date.now());
  }
  expired(): boolean {
    return this.remaining() === 0;
  }
  /** 取子操作超时：不超过剩余预算，也不超过单次上限。 */
  slice(max: number = PROBE_TIMEOUT_MS): number {
    return Math.max(1000, Math.min(max, this.remaining()));
  }
}

/** 把 db 侧的分类原样映射（两边的联合类型是同一套词汇表）。 */
function mapFailure(failure: InfraProbeFailure): BootstrapProbeFailure {
  return failure;
}

/**
 * 顺序执行全部预检；任一失败即返回（不继续浪费时间）。
 *
 * 顺序是刻意的：数据库是唯一的硬依赖，先失败能给出最准确的提示；
 * Redis 与存储只有在数据库可用后才有意义。
 */
export async function runProbes(targets: ProbeTargets): Promise<ProbeResult> {
  const deadline = new Deadline();
  if (deadline.expired()) {
    return { ok: false, failure: 'invalid_config', detail: '预检预算已耗尽' };
  }

  const database = await probePostgresForBootstrap(targets.databaseUrl, {
    connectTimeoutMs: deadline.slice(),
  });
  if (!database.ok) {
    return {
      ok: false,
      failure: mapFailure(database.failure ?? 'database_unreachable'),
      ...(database.detail ? { detail: database.detail } : {}),
    };
  }

  if (targets.redisUrl) {
    const redis = await probeRedisForBootstrap(targets.redisUrl, {
      connectTimeoutMs: deadline.slice(),
    });
    if (!redis.ok) {
      return {
        ok: false,
        failure: mapFailure(redis.failure ?? 'redis_unreachable'),
        ...(redis.detail ? { detail: redis.detail } : {}),
      };
    }
  }

  const storage = targets.storage;
  if (storage) {
    if (storage.driver === 'local') {
      // 生产默认拒绝本地盘（ADR-0017）；这里只在开发路径放行，
      // 且不把"目录可写"当作对象存储可用的证明。
      return { ok: true };
    }
    if (!storage.bucket || !storage.accessKeyId || !storage.secretAccessKey) {
      return {
        ok: false,
        failure: 'invalid_config',
        detail: 'S3 配置不完整（需要 bucket、accessKeyId、secretAccessKey）',
      };
    }
    const s3 = await probeS3ForBootstrap(
      {
        ...(storage.endpoint ? { endpoint: storage.endpoint } : {}),
        ...(storage.region ? { region: storage.region } : {}),
        bucket: storage.bucket,
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
        forcePathStyle: storage.forcePathStyle ?? true,
      },
      { connectTimeoutMs: deadline.slice() },
    );
    if (!s3.ok) {
      return {
        ok: false,
        failure: mapFailure(s3.failure ?? 'storage_unreachable'),
        ...(s3.detail ? { detail: s3.detail } : {}),
      };
    }
  }

  return { ok: true };
}

/** 从提交的配置里解析出探测目标。 */
export function probeTargetsFromConfig(config: Record<string, string | undefined>): ProbeTargets {
  return {
    databaseUrl: config['DATABASE_URL'] ?? '',
    ...(config['REDIS_URL'] ? { redisUrl: config['REDIS_URL'] } : {}),
    ...buildStorageTarget(config),
  };
}

function buildStorageTarget(config: Record<string, string | undefined>): { storage?: StorageTarget } {
  const driver = config['STORAGE_DRIVER'] === 's3' ? 's3' : config['STORAGE_DRIVER'] === 'local' ? 'local' : undefined;
  if (!driver) return {};
  const target: StorageTarget = { driver };
  if (config['STORAGE_S3_ENDPOINT']) target.endpoint = config['STORAGE_S3_ENDPOINT'];
  if (config['STORAGE_S3_REGION']) target.region = config['STORAGE_S3_REGION'];
  if (config['STORAGE_S3_BUCKET']) target.bucket = config['STORAGE_S3_BUCKET'];
  if (config['STORAGE_S3_ACCESS_KEY_ID']) target.accessKeyId = config['STORAGE_S3_ACCESS_KEY_ID'];
  if (config['STORAGE_S3_SECRET_ACCESS_KEY']) {
    target.secretAccessKey = config['STORAGE_S3_SECRET_ACCESS_KEY'];
  }
  if (config['STORAGE_S3_FORCE_PATH_STYLE'] !== undefined) {
    target.forcePathStyle = config['STORAGE_S3_FORCE_PATH_STYLE'] !== 'false';
  }
  return { storage: target };
}
