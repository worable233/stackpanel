/**
 * 首次自举（bootstrap / provision）契约（BOOTSTRAP-R 审计 R1、R3、R4、R8）。
 *
 * 零配置文件安装时，实例先在 `provision` 模式下运行：不连数据库、不装插件，
 * 只暴露最小发现与提交接口，由操作员在浏览器里填写基础设施连接。
 *
 * 本模块是**单一来源**：内核 API、Web 与 runner 共用这些类型与阶段语义，
 * 不依赖任何运行时依赖（可在 CI 与目标机脚本中复用）。
 *
 * 设计要点（不可随意简化）：
 * - 阶段是**显式联合类型**，不是布尔值。布尔只是兼容投影。
 * - `needs_infra` 是唯一允许写基础设施的阶段；一旦候选被验证通过，
 *   任何后续阶段都不得重新开放任意数据库配置（审计 R3）。
 * - 迁移成功、正常运行就绪、管理员认领是**三个独立结果**，不得混为
 *   「进程退出 0」或「PM2 online」（审计 R2）。
 */

/** 自举阶段。单调推进；`*_failed` 是可在受控条件重试的故障态。 */
export type BootstrapPhase =
  /** 尚未提交任何基础设施配置，等待操作员填写。 */
  | 'needs_infra'
  /** 已收到 POST，正在做有界预检（连接、权限、迁移状态）。 */
  | 'validating'
  /** 候选配置已落盘并发布任务，等待 runner 认领。 */
  | 'queued'
  /** runner 正在执行 `migrate deploy`。 */
  | 'migrating'
  /** 迁移失败；需查看脱敏原因后受控重试（不可盲目循环）。 */
  | 'migration_failed'
  /** 迁移成功，正在用新配置启动正常 API / worker。 */
  | 'starting'
  /** 正常 API 或 worker 未就绪；不再开放基础设施写接口。 */
  | 'runtime_failed'
  /** 正常运行，等待创建首个管理员（token 仍有效）。 */
  | 'needs_admin'
  /** 管理员已创建，实例可用。终态。 */
  | 'complete';

/** 终态：不再自动推进。 */
export const BOOTSTRAP_TERMINAL_PHASES: readonly BootstrapPhase[] = Object.freeze(['complete']);

/** 允许提交（或修正）基础设施配置的阶段。 */
export const BOOTSTRAP_WRITABLE_PHASES: readonly BootstrapPhase[] = Object.freeze([
  'needs_infra',
  'migration_failed',
]);

/**
 * 是否需要渲染基础设施表单。`migration_failed` 只在「空库首次安装」时允许修正；
 * 已有业务库的部分失败必须走人工修复，见 {@link BootstrapStatus.diagnosticsRequired}。
 */
export function bootstrapAcceptsConfig(phase: BootstrapPhase): boolean {
  return BOOTSTRAP_WRITABLE_PHASES.includes(phase);
}

/** 配置序列化格式的版本；写入时递增，便于未来迁移磁盘状态。 */
export const BOOTSTRAP_CONFIG_FORMAT_VERSION = 1;

/**
 * 提交基础设施时允许的键（白名单，审计 R7）。
 *
 * 只接受这些键；其余一律 422。这样既避免 `env: {...bootstrap}` 把未知键
 * 注入进程环境，也避免凭据被投影到不该拿到它的进程（Web）。
 */
export const BOOTSTRAP_CONFIG_KEYS = Object.freeze([
  'DATABASE_URL',
  'REDIS_URL',
  'STORAGE_DRIVER',
  'STORAGE_S3_ENDPOINT',
  'STORAGE_S3_REGION',
  'STORAGE_S3_BUCKET',
  'STORAGE_S3_ACCESS_KEY_ID',
  'STORAGE_S3_SECRET_ACCESS_KEY',
  'STORAGE_S3_FORCE_PATH_STYLE',
  'STORAGE_PUBLIC_BASE_URL',
] as const);

export type BootstrapConfigKey = (typeof BOOTSTRAP_CONFIG_KEYS)[number];

/** 提交的基础设施配置（全部为字符串；缺省键表示"未提供"）。 */
export type BootstrapConfig = Partial<Record<BootstrapConfigKey, string>>;

/** 单个键的长度上限；超限直接拒绝，避免把整份文件撑爆。 */
export const BOOTSTRAP_MAX_VALUE_LENGTH = 4096;

/** 单个键是否在允许范围内。 */
export function isBootstrapConfigKey(key: string): key is BootstrapConfigKey {
  return (BOOTSTRAP_CONFIG_KEYS as readonly string[]).includes(key);
}

/** 预检结果分类。公开状态只回这些通用类别，不回原始错误（审计 R8）。 */
export type BootstrapProbeFailure =
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

/** 迁移失败的分类；与预检失败分开，因为处理方式不同（审计 §3.3）。 */
export type BootstrapMigrationFailure =
  | 'migration_connect_failed'
  | 'migration_permission_denied'
  | 'migration_failed_record'
  | 'migration_schema_incompatible'
  | 'migration_unknown';

/** 公开任务投影：不含凭据、不含原始 stderr。 */
export interface BootstrapOperationView {
  /** 幂等键派生的操作 ID（不透明）。 */
  id: string;
  /** 配置代次；用于识别"同一份配置"。 */
  configGeneration: number;
  /** 目标内核版本（迁移产物版本）。 */
  targetVersion: string;
  /** 当前阶段。 */
  phase: BootstrapPhase;
  /** 失败类别（仅 `*_failed` 阶段有值），已脱敏。 */
  failure?: BootstrapProbeFailure | BootstrapMigrationFailure;
  /** 是否必须人工介入（例如已有业务库的部分迁移失败）。 */
  diagnosticsRequired?: boolean;
  /** ISO 时间戳。 */
  createdAt: string;
  updatedAt: string;
}

/**
 * 统一发现接口 `GET /setup/status` 的响应（审计 R1）。
 *
 * 两个 app（provision 与正常）都实现同一路径与同一形状：
 * - `phase` 是权威字段；
 * - `required` / `tokenRequired` 是**兼容投影**，供既有前端与 SDK 逻辑平滑过渡；
 * - `operation` 只在存在进行中/最近一次任务时出现。
 */
export interface BootstrapStatusResponse {
  phase: BootstrapPhase;
  /** 兼容投影：`needs_admin` 或 `needs_infra` 时为 true。 */
  required: boolean;
  /** 兼容投影：完成当前阶段是否必须出示 token。 */
  tokenRequired: boolean;
  /** 当前（或最近一次）任务；没有任务时省略。 */
  operation?: BootstrapOperationView;
}

/** 响应阶段是否需要管理员认领。 */
export function phaseNeedsAdmin(phase: BootstrapPhase): boolean {
  return phase === 'needs_admin';
}

/** 响应阶段是否处于首次自举（未完成）。 */
export function phaseNeedsInfra(phase: BootstrapPhase): boolean {
  return phase === 'needs_infra' || phase === 'migration_failed';
}

/**
 * 把详细阶段压成 `{ required, tokenRequired }` 兼容投影。
 *
 * 注意 `migration_failed` / `runtime_failed` 仍属于「需要操作员处理」，
 * 因此 `required` 为 true —— 但它们**不接受**基础设施提交，
 * 是否可写要用 {@link bootstrapAcceptsConfig} 判断。
 */
export function projectBootstrapStatus(
  phase: BootstrapPhase,
  tokenRequired: boolean,
): { required: boolean; tokenRequired: boolean } {
  const required =
    phase === 'needs_infra' ||
    phase === 'migration_failed' ||
    phase === 'runtime_failed' ||
    phase === 'needs_admin' ||
    phase === 'validating' ||
    phase === 'queued' ||
    phase === 'migrating' ||
    phase === 'starting';
  return { required, tokenRequired };
}

/** `POST /setup/provision` 的请求体。 */
export interface BootstrapProvisionInput {
  /** 一次性认领令牌；provision 模式强制要求。 */
  setupToken: string;
  /** 幂等键；同键同配置返回同一任务，同键异配置 409。 */
  idempotencyKey: string;
  config: BootstrapConfig;
}

/** `POST /setup/provision` 成功响应（202）。 */
export interface BootstrapProvisionAccepted {
  operation: BootstrapOperationView;
}

/** 自举相关的稳定错误码。 */
export const BOOTSTRAP_ERROR_CODES = Object.freeze({
  /** 当前阶段不接受基础设施提交（已配置 / 正在执行 / 已完成）。 */
  notWritable: 'bootstrap.not_writable',
  /** 令牌缺失或错误。 */
  tokenInvalid: 'bootstrap.token_invalid',
  /** 同一幂等键配了不同配置。 */
  idempotencyConflict: 'bootstrap.idempotency_conflict',
  /** 配置键不在白名单、值的字符集非法或超长。 */
  invalidConfig: 'bootstrap.invalid_config',
  /** 预检失败；`failure` 字段给出分类。 */
  probeFailed: 'bootstrap.probe_failed',
  /** 实例已完成迁移，不再接受基础设施配置。 */
  alreadyCompleted: 'bootstrap.already_completed',
  /** 被另一次并发的配置发布抢先；调用方应刷新后按新状态重试。 */
  generationMismatch: 'bootstrap.generation_mismatch',
} as const);

export type BootstrapErrorCode = (typeof BOOTSTRAP_ERROR_CODES)[keyof typeof BOOTSTRAP_ERROR_CODES];
