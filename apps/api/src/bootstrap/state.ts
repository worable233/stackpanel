/**
 * 自举状态机与磁盘状态（审计 R3）。
 *
 * 为什么不能只用 `STACKPANEL_PROVISIONING=0|1`：
 * - 二值标记无法表达「已提交但未迁移」「迁移失败」「迁移成功但启动失败」；
 * - 也无法区分「未配置」与「配置了但库挂了」——后者绝不能回落到可写配置。
 *
 * 因此把**详细阶段**放在独立状态文件里（不进 env，因为 env 只该有
 * 「进程启动所需的投影」）。env 文件里的 `STACKPANEL_BOOTSTRAP_STATE`
 * 是给启动分支用的**只读投影**，永远由这里派生，不手改。
 *
 * 并发协议（审计 R3）：
 * - 提交先落**不可变候选文件** `config.candidate-<generation>.env`；
 * - 再原子写 `state.json`（内含 generation）作为「发布点」；
 * - runner 认领后核对 generation，不一致就放弃，不做破坏性动作；
 * - 同一幂等键 + 相同配置 → 返回同一任务；同键异配置 → 409。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BOOTSTRAP_WRITABLE_PHASES,
  type BootstrapMigrationFailure,
  type BootstrapOperationView,
  type BootstrapPhase,
  type BootstrapProbeFailure,
} from '@stackpanel/spec';
import { writeFileAtomic } from './config-file.ts';

/** 磁盘状态格式版本。 */
export const BOOTSTRAP_STATE_VERSION = 1;

/** 持久化状态（不对外暴露原始字段；公开投影见 `toOperationView`）。 */
export interface BootstrapState {
  version: number;
  phase: BootstrapPhase;
  /** 配置代次；每次成功提交候选 +1。 */
  configGeneration: number;
  /** 幂等键；用于识别重复提交。 */
  idempotencyKey?: string;
  /**
   * `validating` 期间暂存的原始阶段，用于预检失败时**精确恢复**。
   * 没有它就只能猜「回到 needs_infra 还是 migration_failed」，
   * 而猜错会把一次失败修正的尝试伪装成全新安装。
   */
  validationBasePhase?: BootstrapPhase;
  /**
   * 正在验证的请求的幂等键。
   *
   * 与 `idempotencyKey` 分开：后者描述**已发布**的候选，预检期间还没有
   * 候选可发布。混用会让 publishCandidate 的幂等判定把「自己」当成
   * 「同键异配置」的冲突。
   */
  validatingKey?: string;
  /** 已发布配置的内容摘要（不含明文），用于「同键同配置」判定。 */
  configDigest?: string;
  /** 目标内核版本（迁移产物版本）。 */
  targetVersion?: string;
  /** 失败分类（已脱敏）。 */
  failure?: BootstrapProbeFailure | BootstrapMigrationFailure;
  /** 是否必须人工介入。 */
  diagnosticsRequired?: boolean;
  /** 三个独立结果，不合并（审计 R2）。 */
  migrationSucceeded?: boolean;
  runtimeReady?: boolean;
  adminClaimed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BootstrapStateStoreOptions {
  /** 状态目录（与版本目录分离，例如 `/var/lib/stackpanel/bootstrap`）。 */
  dir: string;
  /** 目标内核版本；写进任务记录，供 runner 核对产物绑定。 */
  targetVersion?: string;
  now?: () => Date;
}

/** 状态文件的默认位置（相对状态目录）。 */
const STATE_FILE = 'state.json';
/** 候选配置的文件名前缀；`config.candidate-<generation>.env`。 */
const CANDIDATE_PREFIX = 'config.candidate-';

export class BootstrapStateError extends Error {
  constructor(
    message: string,
    readonly code: 'not_writable' | 'generation_mismatch' | 'corrupt_state' = 'not_writable',
  ) {
    super(message);
    this.name = 'BootstrapStateError';
  }
}

/** 默认状态目录：`<stateDir>/bootstrap`。 */
export function defaultBootstrapStateDir(stateDir: string): string {
  return path.join(stateDir, 'bootstrap');
}

/** 生成候选配置文件路径。 */
export function candidateConfigPath(dir: string, generation: number): string {
  return path.join(dir, `${CANDIDATE_PREFIX}${generation}.env`);
}

/** 由幂等键派生不透明操作 ID（不暴露原键，避免被猜测）。 */
export function operationIdFromKey(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
}

/** 初始状态（安装脚本写入，或首次运行时发现无状态文件）。 */
export function initialState(now: Date, phase: BootstrapPhase = 'needs_infra'): BootstrapState {
  const timestamp = now.toISOString();
  return {
    version: BOOTSTRAP_STATE_VERSION,
    phase,
    configGeneration: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export class BootstrapStateStore {
  private readonly now: () => Date;

  constructor(private readonly opts: BootstrapStateStoreOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  private get statePath(): string {
    return path.join(this.opts.dir, STATE_FILE);
  }

  /** 读取状态；不存在返回 null。损坏时抛错，绝不静默新建（否则会把已装实例打回自举）。 */
  async read(): Promise<BootstrapState | null> {
    let content: string;
    try {
      content = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new BootstrapStateError(`自举状态文件损坏：${this.statePath}`, 'corrupt_state');
    }
    if (!isBootstrapState(parsed)) {
      throw new BootstrapStateError(`自举状态文件格式非法：${this.statePath}`, 'corrupt_state');
    }
    return parsed;
  }

  /** 原子写状态（含父目录 fsync）。 */
  async write(state: BootstrapState): Promise<void> {
    await writeFileAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o640 });
  }

  /**
   * 原子地进入 `validating`（审计 R1/R3）。
   *
   * 预检要访问外部系统，可能持续数十秒；期间磁盘状态必须反映「有人正在
   * 验证」。这个方法是**先写状态再探测**的认领：并发提交里只有一个能拿到
   * `validating`，其余在写之前就被拒绝，不可能出现两个请求同时探测并写候选。
   *
   * 幂等重放（同键同配置）不应走到这里；调用方已在上层处理。
   */
  async beginValidation(input: { idempotencyKey: string }): Promise<BootstrapState> {
    const current = (await this.read()) ?? initialState(this.now());
    if (!BOOTSTRAP_WRITABLE_PHASES.includes(current.phase)) {
      throw new BootstrapStateError(
        `当前阶段 ${current.phase} 不接受新的基础设施配置`,
        'not_writable',
      );
    }
    const next: BootstrapState = {
      ...current,
      version: BOOTSTRAP_STATE_VERSION,
      phase: 'validating',
      validatingKey: input.idempotencyKey,
      validationBasePhase: current.phase,
      updatedAt: this.now().toISOString(),
    };
    await this.write(next);
    return next;
  }

  /**
   * 预检失败：把状态精确恢复到进入 `validating` 之前的阶段，并记录脱敏分类。
   *
   * 只对「同一个认领者」生效（幂等键比对），避免一个已超时的请求把另一个
   * 请求刚刚发布的阶段覆盖回旧值。
   */
  async abortValidation(input: {
    idempotencyKey: string;
    failure: BootstrapProbeFailure;
  }): Promise<BootstrapState | null> {
    const current = await this.read();
    if (!current) return null;
    if (current.phase !== 'validating' || current.validatingKey !== input.idempotencyKey) {
      return current;
    }
    const next: BootstrapState = {
      ...current,
      version: BOOTSTRAP_STATE_VERSION,
      phase: current.validationBasePhase ?? 'needs_infra',
      failure: input.failure,
      updatedAt: this.now().toISOString(),
    };
    delete next.validationBasePhase;
    delete next.validatingKey;
    await this.write(next);
    return next;
  }

  /**
   * 提交候选配置（审计 R3 的「不可变候选 + 代次发布」）。
   *
   * 调用方必须**先**完成预检；这里只负责持久化与阶段推进。
   * 返回新状态；`operation` 字段随状态一起返回，便于 API 立即回显。
   */
  async publishCandidate(input: {
    configContent: string;
    configDigest: string;
    idempotencyKey: string;
    /** 预检通过后的初始阶段；通常为 `queued`。 */
    nextPhase?: BootstrapPhase;
  }): Promise<BootstrapState> {
    const current = (await this.read()) ?? initialState(this.now());

    // 同一幂等键 + 同一配置：幂等重放，不新建候选。
    if (
      current.idempotencyKey === input.idempotencyKey &&
      current.configDigest === input.configDigest
    ) {
      return current;
    }
    // 同一幂等键 + 不同配置：冲突（审计 R3）。
    if (current.idempotencyKey === input.idempotencyKey && current.configDigest !== input.configDigest) {
      throw new BootstrapStateError('同一幂等键对应不同配置', 'generation_mismatch');
    }
    // `validating` 只允许**同一个认领者**提交：别的请求在 beginValidation
    // 就会被拒；这里再校验一次，防止伪造的幂等键越过阶段门。
    if (current.phase === 'validating') {
      if (current.validatingKey !== input.idempotencyKey) {
        throw new BootstrapStateError('另一个请求正在验证配置', 'not_writable');
      }
    } else if (current.phase !== 'needs_infra' && current.phase !== 'migration_failed') {
      throw new BootstrapStateError(`当前阶段 ${current.phase} 不接受新的基础设施配置`, 'not_writable');
    }

    const generation = current.configGeneration + 1;
    // 先落不可变候选：即使随后崩溃，磁盘上也只多一个未被引用的文件。
    await writeFileAtomic(candidateConfigPath(this.opts.dir, generation), input.configContent, {
      mode: 0o640,
    });

    const timestamp = this.now().toISOString();
    const next: BootstrapState = {
      version: BOOTSTRAP_STATE_VERSION,
      phase: input.nextPhase ?? 'queued',
      configGeneration: generation,
      idempotencyKey: input.idempotencyKey,
      configDigest: input.configDigest,
      ...(this.opts.targetVersion ? { targetVersion: this.opts.targetVersion } : {}),
      migrationSucceeded: false,
      runtimeReady: false,
      adminClaimed: false,
      createdAt: current.createdAt,
      updatedAt: timestamp,
    };
    // 进入 queued 后验证期的临时字段已无意义；显式清掉，避免后续误读。
    delete next.validationBasePhase;
    delete next.validatingKey;
    await this.write(next);
    return next;
  }

  /**
   * 推进阶段（runner 与 API 共用）。
   *
   * `expectedGeneration` 用于乐观并发：与磁盘不一致时拒绝，防止旧执行者
   * 覆盖新状态。
   */
  async transition(
    patch: Partial<BootstrapState> & { phase: BootstrapPhase },
    options: { expectedGeneration?: number } = {},
  ): Promise<BootstrapState> {
    const current = await this.read();
    if (!current) {
      throw new BootstrapStateError('自举状态尚未初始化', 'corrupt_state');
    }
    if (
      options.expectedGeneration !== undefined &&
      current.configGeneration !== options.expectedGeneration
    ) {
      throw new BootstrapStateError(
        `配置代次已变化（磁盘 ${current.configGeneration}，期望 ${options.expectedGeneration}）`,
        'generation_mismatch',
      );
    }
    const next: BootstrapState = {
      ...current,
      ...patch,
      version: BOOTSTRAP_STATE_VERSION,
      updatedAt: this.now().toISOString(),
    };
    await this.write(next);
    return next;
  }
}

/** 把磁盘状态投影为公开视图（不含凭据与原始错误）。 */
export function toOperationView(
  state: BootstrapState,
  idempotencyKey: string | undefined,
): BootstrapOperationView {
  const view: BootstrapOperationView = {
    id: operationIdFromKey(idempotencyKey ?? `${state.configGeneration}`),
    configGeneration: state.configGeneration,
    targetVersion: state.targetVersion ?? 'unknown',
    phase: state.phase,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
  if (state.failure) view.failure = state.failure;
  if (state.diagnosticsRequired) view.diagnosticsRequired = true;
  return view;
}

function isBootstrapState(value: unknown): value is BootstrapState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['version'] === 'number' &&
    typeof record['phase'] === 'string' &&
    typeof record['configGeneration'] === 'number' &&
    typeof record['createdAt'] === 'string' &&
    typeof record['updatedAt'] === 'string'
  );
}
