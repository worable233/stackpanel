/**
 * 统一安装事务与失败兜底契约（PLAN-github-distribution-and-updates §6、§7）。
 *
 * 市场、上传、自动更新、重装**全部调用同一个 `PackageManager`**，只有来源不同。
 * 本模块定义事务步骤、候选求解结果与失败兜底矩阵的机器可读形状，供内核
 * `apps/api/src/packages/**` 实现与测试引用。
 */

/** 安装来源。所有来源走同一事务（§7 首段）。 */
export type PackageSourceKind = 'market' | 'upload' | 'auto-update' | 'reinstall';

/**
 * 安装事务步骤（§7 的 8 条）。每步都必须有可观测的输入/输出凭据；缺文件或目标节点
 * 未就绪则**不激活**。
 */
export const INSTALL_TRANSACTION_STEPS: readonly string[] = Object.freeze([
  'resolve',
  'verify',
  'stage',
  'materialize',
  'probe',
  'swap',
  'commit',
  'gc',
]);

/**
 * 事务阶段失败时的兜底动作（§6 表）。
 */
export type FailureStage =
  | 'download'
  | 'signature'
  | 'preflight'
  | 'quiesce'
  | 'snapshot'
  | 'migration'
  | 'new_version_start'
  | 'probe'
  | 'post_write';

export interface FailureFallback {
  stage: FailureStage;
  /** 自动处理策略（人类可读，供运维与审计）。 */
  automatic: string;
}

export const FAILURE_FALLBACKS: readonly FailureFallback[] = Object.freeze([
  { stage: 'download', automatic: '清理候选或保留可复用缓存，原版本继续服务' },
  { stage: 'signature', automatic: '清理候选，原版本继续服务；禁止降级验签' },
  { stage: 'preflight', automatic: '清理候选，原版本继续服务' },
  { stage: 'quiesce', automatic: '未迁移则解除维护，恢复原消费者' },
  { stage: 'snapshot', automatic: '未迁移则解除维护，恢复原消费者' },
  {
    stage: 'migration',
    automatic: '识别事务及 Prisma 迁移状态；禁止盲目 migrate resolve/retry；必要时恢复快照和原版本',
  },
  {
    stage: 'new_version_start',
    automatic: '旧程序兼容新 schema 时切回旧 digest，探针通过再恢复服务',
  },
  {
    stage: 'probe',
    automatic: '探针失败 → recovering；新 schema 不兼容旧程序且未放行写入则恢复快照与匹配旧包',
  },
  { stage: 'post_write', automatic: '兼容程序回退或前向修复；不得自动恢复旧快照丢弃新数据' },
]);

/** 安装事务结果。 */
export interface InstallTransactionResult {
  kind: 'plugin' | 'theme';
  id: string;
  fromVersion: string | null;
  toVersion: string;
  /** 实际安装的 digest（记录实际摘要，而非只记版本名，§3.1）。 */
  revision: string;
  /** 事务是否激活新版本。 */
  activated: boolean;
  /** 失败时的阶段与兜底说明。 */
  failure?: { stage: FailureStage; detail: string };
}

/**
 * 更新包时必须保留的状态（§7.3）。
 */
export interface PreservedPackageState {
  /** 原启用状态；升级不得擅自启用原先停用的插件。 */
  enabled: boolean;
  /** 插件/主题配置。 */
  settings: Record<string, unknown>;
  /** 数据归属（迁移协议声明的目标 schema）。 */
  dataOwner?: string;
}

/**
 * 版本比较判定（§4）。**不要**采用 `installedVersion !== sourceVersion` 判定升级；
 * 应使用 SemVer、渠道和 pin 规则。本函数给出方向判定，调用方叠加渠道/pin。
 */
export type VersionDirection = 'newer' | 'same' | 'older';

/** GC 保留策略（§7.8）。 */
export interface RetentionPolicy {
  /** 至少保留的上一成功版本数。 */
  keepPreviousVersions: number;
  /** 保留天数。 */
  retentionDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  keepPreviousVersions: 1,
  retentionDays: 7,
});

/** 判断某产物是否仍被引用（活动部署 / 回退计划 / 在途请求 / 保留期）。 */
export interface GcReferences {
  activeRevisions: string[];
  rollbackRevisions: string[];
  inFlightRevisions: string[];
  /** revision → 最后引用时间（ISO）。 */
  lastUsedAt: Record<string, string>;
}

/**
 * GC 候选：未被任何引用覆盖且超过保留期的 revision。纯函数，便于测试「不会删
 * 正在服务的目录」。
 */
export function collectGcCandidates(
  revisions: string[],
  references: GcReferences,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  now: Date = new Date(),
): string[] {
  const protectedSet = new Set([
    ...references.activeRevisions,
    ...references.rollbackRevisions,
    ...references.inFlightRevisions,
  ]);
  const cutoff = now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000;
  return revisions.filter((revision) => {
    if (protectedSet.has(revision)) return false;
    const lastUsed = references.lastUsedAt[revision];
    if (!lastUsed) return false;
    return Date.parse(lastUsed) < cutoff;
  });
}
