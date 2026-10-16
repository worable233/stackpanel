/**
 * 独立恢复入口的动作接线（PLAN-github-distribution-and-updates §5.2、§6）。
 *
 * §5.2 要求独立恢复入口提供**受限白名单**动作：重试当前任务 / 回退到上一代 / 重新对账
 * 现场。HTTP 契约与独立认证已在 {@link ./recovery-entry.ts} 就绪；本模块把这三个动作接到
 * 真实的通道、权威日志、部署指针与部署适配器上，且：
 *
 * - **不绕过状态机与执行权**：重试是**重新投递**一份任务到通道（由同一轮询循环在持有
 *   执行权时认领执行），绝不在 HTTP 处理线程里直接跑迁移/切换；回退与对账只调用适配器
 *   的受限方法。
 * - **不假报成功**：适配器未提供回退/对账能力时返回 `ok:false` 并说明，而非假装完成。
 * - 重试用**新的幂等键**（`<原键>-retry-<时间戳>`），因此不违反「同一幂等键不得二次执行」
 *   的权威日志约束（§5.1）；原任务日志保持 append-only、不倒退（§5.2）。
 *
 * 全部依赖可注入，便于在不碰真实 Docker 的情况下单测每个动作。
 */

import type { UpdateTask } from '@stackpanel/spec';
import type { DeploymentAdapter } from './deployment-adapter.ts';
import type { FileUpdateJournal } from './journal.ts';
import type { FileDeploymentPointer } from './deployment-pointer.ts';
import type { FileUpdaterStatus } from './status.ts';
import type { UpdateTaskChannel } from './task-channel.ts';

/** 重试循环上限：避免无限自动重试（人工恢复仍可再触发）。 */
export const MAX_AUTO_RETRIES = 3;

/** 恢复动作结果（与 {@link ./recovery-entry.ts} 的 deps 契约一致）。 */
export interface RecoveryActionResult {
  ok: boolean;
  detail: string;
}

export interface RecoveryCoordinatorDeps {
  instanceId: string;
  channel: UpdateTaskChannel;
  journal: FileUpdateJournal;
  status: FileUpdaterStatus;
  pointer: FileDeploymentPointer;
  adapter: DeploymentAdapter;
  now?: () => Date;
  log?: (message: string) => void;
}

/** 可按需重试的终结阶段（自动动作**不**重试 `blocked`：那需要人工改策略）。 */
const RETRYABLE_PHASES = new Set(['recovered', 'recovery_failed']);

export class RecoveryCoordinator {
  private readonly now: () => Date;

  constructor(private readonly deps: RecoveryCoordinatorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 重试：把**已归档的完整任务**以新幂等键重新投递，交由执行循环在持有执行权时重跑。
   * 未指定键时取最近一次可重试（recovered / recovery_failed）结果。
   */
  async retry(idempotencyKey?: string): Promise<RecoveryActionResult> {
    const key = idempotencyKey ?? (await this.latestRetryableKey());
    if (!key) {
      return { ok: false, detail: '没有可重试的任务（未指定键且无失败记录）' };
    }
    const archived = await this.deps.channel.readArchivedTask(this.deps.instanceId, key);
    if (!archived) {
      return { ok: false, detail: `找不到任务 ${key} 的归档声明，无法安全重试` };
    }
    const attempts = await this.countRetries(key);
    if (attempts >= MAX_AUTO_RETRIES) {
      return {
        ok: false,
        detail: `任务 ${key} 已自动重试 ${attempts} 次，达到上限；请人工介入或前向修复`,
      };
    }
    const pointer = await this.deps.pointer.read();
    const retryKey = `${key}-retry-${this.now().getTime()}`;
    const retryTask: UpdateTask = {
      ...archived,
      idempotencyKey: retryKey,
      // 基线代次以当前指针为准：原任务已终结、现场可能已变，旧基线会误判「陈旧计划」。
      baselineGeneration: pointer?.generation ?? archived.baselineGeneration,
      createdAt: this.now().toISOString(),
    };
    await this.deps.channel.submit(retryTask);
    this.deps.log?.(`恢复入口重试：${key} → 重新投递 ${retryKey}`);
    return { ok: true, detail: `已重新投递任务（${retryKey}），由执行循环在持有执行权时重跑` };
  }

  /** 回退：调用适配器的受限「回退上一代」方法；未提供能力则明确返回不支持。 */
  async rollback(): Promise<RecoveryActionResult> {
    if (!this.deps.adapter.rollbackToPrevious) {
      return { ok: false, detail: '当前部署适配器不支持回退上一代（未配置能力）' };
    }
    try {
      const result = await this.deps.adapter.rollbackToPrevious();
      this.deps.log?.(`恢复入口回退：${result.detail}`);
      return result;
    } catch (error) {
      return {
        ok: false,
        detail: `回退失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** 对账：读取现场（指针 + 适配器探针），幂等、不改部署。 */
  async reconcile(): Promise<RecoveryActionResult> {
    const pointer = await this.deps.pointer.read();
    if (!this.deps.adapter.reconcile) {
      return {
        ok: true,
        detail: `适配器无对账能力；当前代次 ${pointer?.generation ?? 0}，digest ${pointer?.digest ?? '无'}`,
      };
    }
    try {
      const result = await this.deps.adapter.reconcile();
      this.deps.log?.(`恢复入口对账：${result.detail}`);
      return {
        ok: result.ok,
        detail: `代次 ${result.generation}，digest ${result.digest ?? '无'}；${result.detail}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `对账失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** 最近一次可重试结果的幂等键，无则 null。 */
  private async latestRetryableKey(): Promise<string | null> {
    const status = await this.deps.status.read();
    if (!status) return null;
    const entry = status.recent.find((item) => RETRYABLE_PHASES.has(item.result.phase));
    return entry?.idempotencyKey ?? null;
  }

  /** 统计对某原始任务已发起的自动重试次数（按日志中的重试任务键前缀）。 */
  private async countRetries(originalKey: string): Promise<number> {
    const prefix = `${this.deps.instanceId}:${originalKey}-retry-`;
    const entries = await this.deps.journal.entries();
    const keys = new Set(
      entries
        .filter((entry) => entry.phase === 'queued' && entry.taskKey.startsWith(prefix))
        .map((entry) => entry.taskKey),
    );
    return keys.size;
  }
}
