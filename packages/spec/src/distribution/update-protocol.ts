/**
 * 内核升级协议与状态机契约（PLAN-github-distribution-and-updates §5）。
 *
 * 这里定义**声明式升级任务**与**状态机**的机器可读形状。API 只提交任务；updater
 * 通过实例私有、带身份认证的通道取得任务。任务最少绑定实例 ID、基线 generation、
 * 目标摘要、计划摘要、幂等键及授权策略版本（§5.1）。
 *
 * 本模块零运行时依赖，供内核 `apps/api/src/updates/**`、独立 `apps/updater/**` 与
 * 测试共同引用。
 */

/** 升级协议版本；updater 与内核必须协商一致（§5.2）。 */
export const UPDATE_PROTOCOL_VERSION = 1;

/**
 * 状态机（§5.3）。成功路径单调推进；任何步骤失败进入 `recovering`；不满足策略或
 * 兼容性进入 `blocked`（保留原部署）。
 */
export type UpdatePhase =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'verified'
  | 'preflight'
  | 'quiescing'
  | 'snapshotting'
  | 'migrating'
  | 'switching'
  | 'verifying'
  | 'committed'
  | 'cleanup'
  | 'recovering'
  | 'recovered'
  | 'recovery_failed'
  | 'blocked';

/** 终态：不再自动推进。 */
export const UPDATE_TERMINAL_PHASES: readonly UpdatePhase[] = Object.freeze([
  'committed',
  'recovered',
  'recovery_failed',
  'blocked',
]);

/** 成功主路径（不含 cleanup 之后的终态判定）。 */
export const UPDATE_SUCCESS_PATH: readonly UpdatePhase[] = Object.freeze([
  'queued',
  'resolving',
  'downloading',
  'verified',
  'preflight',
  'quiescing',
  'snapshotting',
  'migrating',
  'switching',
  'verifying',
  'committed',
  'cleanup',
]);

/** 合法迁移表。未列出的迁移一律拒绝（防止状态机跳步）。 */
const TRANSITIONS: Record<UpdatePhase, readonly UpdatePhase[]> = {
  queued: ['resolving', 'blocked', 'recovering'],
  resolving: ['downloading', 'blocked', 'recovering'],
  downloading: ['verified', 'blocked', 'recovering'],
  verified: ['preflight', 'blocked', 'recovering'],
  preflight: ['quiescing', 'blocked', 'recovering'],
  quiescing: ['snapshotting', 'recovering'],
  snapshotting: ['migrating', 'recovering'],
  migrating: ['switching', 'recovering'],
  switching: ['verifying', 'recovering'],
  verifying: ['committed', 'recovering'],
  committed: ['cleanup', 'recovering'],
  cleanup: [],
  recovering: ['recovered', 'recovery_failed'],
  recovered: [],
  recovery_failed: [],
  blocked: [],
};

/** 该迁移是否被状态机允许。 */
export function canTransition(from: UpdatePhase, to: UpdatePhase): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** 断言迁移合法，否则抛错（供 updater 使用，避免静默跳步）。 */
export function assertTransition(from: UpdatePhase, to: UpdatePhase): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态迁移：${from} → ${to}`);
  }
}

export function isTerminalPhase(phase: UpdatePhase): boolean {
  return UPDATE_TERMINAL_PHASES.includes(phase);
}

/**
 * 声明式升级任务（§5.1）。API 提交、updater 消费；不向公网提供 Docker 代理或
 * 通用命令执行。
 */
export interface UpdateTask {
  /** 协议版本。 */
  protocolVersion: number;
  /** 实例 ID（updater 只服务绑定实例）。 */
  instanceId: string;
  /** 基线 generation；变化即拒绝执行（防并发/防陈旧计划）。 */
  baselineGeneration: number;
  /** 目标内核镜像摘要（完整 `@sha256` 引用）。 */
  targetDigest: string;
  /** 完整部署计划的摘要（内核+builtin+可选+主题+schema+ABI）。 */
  planDigest: string;
  /** 幂等键；重放同一任务不得二次执行。 */
  idempotencyKey: string;
  /** 授权策略版本；策略变化需重新授权。 */
  policyVersion: number;
  /** 计划内容（供 updater 展示与执行；已由内核求解）。 */
  plan: DeploymentPlan;
  /** 提交时间（ISO）。 */
  createdAt: string;
}

/** 一次更新先计算的**完整部署计划**（§4）。 */
export interface DeploymentPlan {
  /** 目标内核版本与镜像。 */
  kernel: { version: string; digest: string; migration: string };
  /** 计划的组件版本（builtin / 可选插件 / 主题）。 */
  packages: PlannedPackage[];
  /** 计划涉及的全部内容摘要，用于求解一致性。 */
  planDigestInput: PlanDigestInput;
}

export interface PlannedPackage {
  kind: 'plugin' | 'theme';
  id: string;
  fromVersion: string | null;
  toVersion: string;
  /** 目标包 revision（内容摘要）。 */
  revision: string;
  /** 是否新增权限（权限增加不自动执行）。 */
  addsPermissions: boolean;
  /** 是否可恢复迁移。 */
  reversible: boolean;
}

/** 计划摘要的规范化输入；顺序固定以保证可复现。 */
export interface PlanDigestInput {
  kernelVersion: string;
  packages: Array<{ kind: string; id: string; version: string; revision: string }>;
  frontendAbi: string;
  schemaRange: string;
}

/** 阻止原因（进入 `blocked` 时给出具体依赖冲突或策略原因，§4）。 */
export interface BlockReason {
  code:
    | 'policy'
    | 'incompatible_kernel'
    | 'incompatible_abi'
    | 'dependency_conflict'
    | 'permission_increase'
    | 'irreversible_migration'
    | 'insufficient_space'
    | 'expired_catalog';
  detail: string;
}

/** 任务执行结果投影（业务库只保存投影；权威日志在 updater 独立卷，§5.2/§11）。 */
export interface UpdateTaskResult {
  phase: UpdatePhase;
  /** 每步完成的输入摘要与凭据（脱敏后投影）。 */
  checkpoints: UpdateCheckpoint[];
  block?: BlockReason;
  /** 失败时的恢复结果。 */
  recovery?: { recovered: boolean; backupRef?: string; detail: string };
}

export interface UpdateCheckpoint {
  phase: UpdatePhase;
  at: string;
  /** 该步骤输入的摘要。 */
  inputDigest: string;
  /** 该步骤完成的凭据（如摘要 / 探针结果）。 */
  credential?: string;
}
