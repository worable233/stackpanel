/**
 * 升级执行引擎（PLAN-github-distribution-and-updates §5.3、§5.4）。
 *
 * 把状态机 `queued → resolving → downloading → verified → preflight → quiescing →
 * snapshotting → migrating → switching → verifying → committed → cleanup` 落到可持久、
 * 可断点续跑的驱动器上：
 *
 * - 每一步先 `assertOwned()`（持有执行权）再执行，完成后把**输入摘要 + 完成凭据**追加
 *   到权威日志（§5.3「每个步骤记录输入摘要和完成凭据」）。
 * - 重启后从日志**已完成阶段**的下一步继续，不凭内存猜测（§5.3）。
 * - 任一步失败 → `recovering` → 适配器恢复 → `recovered` / `recovery_failed`（§6）。
 * - 迁移前失败可安全重跑；迁移后失败交由适配器据「是否已迁移写入」决定回退方式。
 *
 * 引擎不直接接触 Docker/DB，全部经 {@link DeploymentAdapter}，因此可用假适配器测试
 * 状态推进、断点续跑、失败恢复与执行权丢失下的停手行为。
 */

import {
  UPDATE_SUCCESS_PATH,
  assertTransition,
  canTransition,
  isTerminalPhase,
  type UpdatePhase,
  type UpdateTask,
} from '@stackpanel/spec';
import type { DeploymentAdapter, StepContext } from './deployment-adapter.ts';
import type { FileUpdateJournal } from './journal.ts';
import type { ExecutorLock } from './executor-lock.ts';

export interface EngineOptions {
  adapter: DeploymentAdapter;
  journal: FileUpdateJournal;
  lock: ExecutorLock;
  workDir: string;
  now?: () => Date;
}

/** 成功路径中「仅记账、无适配器动作」的阶段。 */
const BOOKKEEPING_PHASES: readonly UpdatePhase[] = ['queued', 'resolving', 'verified'];

/** 每个工作阶段对应的适配器动作。 */
function actionFor(adapter: DeploymentAdapter, phase: UpdatePhase) {
  switch (phase) {
    case 'downloading':
      return (ctx: StepContext) => adapter.download(ctx);
    case 'preflight':
      return (ctx: StepContext) => adapter.preflight(ctx);
    case 'quiescing':
      return (ctx: StepContext) => adapter.quiesce(ctx);
    case 'snapshotting':
      return (ctx: StepContext) => adapter.snapshot(ctx);
    case 'migrating':
      return (ctx: StepContext) => adapter.migrate(ctx);
    case 'switching':
      return (ctx: StepContext) => adapter.switchTo(ctx);
    case 'verifying':
      return (ctx: StepContext) => adapter.verify(ctx);
    case 'committed':
      return (ctx: StepContext) => adapter.commit(ctx);
    case 'cleanup':
      return (ctx: StepContext) => adapter.cleanup(ctx);
    default:
      return null;
  }
}

export type EngineRunResult =
  | { phase: 'committed'; checkpoints: number }
  | { phase: 'recovered'; detail: string; checkpoints: number }
  | { phase: 'recovery_failed'; detail: string; checkpoints: number }
  | { phase: 'blocked'; detail: string; checkpoints: number };

export class UpdateEngine {
  private readonly now: () => Date;

  constructor(private readonly opts: EngineOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /** 幂等键：同一任务重放不得二次执行（§5.1）。 */
  private taskKey(task: UpdateTask): string {
    return `${task.instanceId}:${task.idempotencyKey}`;
  }

  private context(task: UpdateTask): StepContext {
    return {
      task,
      targetDigest: task.targetDigest,
      planDigest: task.planDigest,
      workDir: this.opts.workDir,
    };
  }

  private async record(
    task: UpdateTask,
    phase: UpdatePhase,
    credential?: string,
    note?: string,
  ): Promise<void> {
    await this.opts.journal.append({
      at: this.now().toISOString(),
      instanceId: task.instanceId,
      taskKey: this.taskKey(task),
      phase,
      inputDigest: task.planDigest,
      ...(credential !== undefined ? { credential } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }

  private async completedPhases(task: UpdateTask): Promise<Set<UpdatePhase>> {
    const entries = await this.opts.journal.forTask(this.taskKey(task));
    return new Set(entries.map((entry) => entry.phase));
  }

  private async latestPhase(task: UpdateTask): Promise<UpdatePhase | null> {
    return this.opts.journal.latestPhase(this.taskKey(task));
  }

  /**
   * 执行（或续跑）一个升级任务。
   *
   * @param approved 已通过策略与兼容性求解（内核侧完成）；false 直接进入 `blocked`。
   */
  async run(task: UpdateTask, approved = true): Promise<EngineRunResult> {
    if (task.protocolVersion !== 1) {
      return { phase: 'blocked', detail: '不支持的升级协议版本', checkpoints: 0 };
    }
    await this.opts.lock.acquire();
    try {
      return await this.drive(task, approved);
    } finally {
      await this.opts.lock.release();
    }
  }

  private async drive(task: UpdateTask, approved: boolean): Promise<EngineRunResult> {
    const done = await this.completedPhases(task);
    const ctx = this.context(task);

    // 幂等：已终结的任务不重跑（§5.1）。
    const latest = await this.latestPhase(task);
    if (latest && isTerminalPhase(latest)) {
      return terminalResult(latest, done.size);
    }

    if (done.size === 0) {
      await this.record(task, 'queued', task.idempotencyKey);
      done.add('queued');
    }

    if (!approved) {
      await this.record(task, 'blocked', undefined, '策略阻止');
      return { phase: 'blocked', detail: '策略阻止', checkpoints: done.size };
    }

    // 上次失败停在 recovering：走恢复，不继续主路径。
    if (latest === 'recovering') {
      const migrated = done.has('migrating') || done.has('switching') || done.has('verifying');
      return this.recover(task, ctx, 'restart-after-failure', migrated);
    }

    // 找到断点：从最后一个已完成阶段的下一阶段开始。
    for (const phase of UPDATE_SUCCESS_PATH) {
      if (done.has(phase)) continue;
      if (phase === 'queued') continue; // 已在上面处理
      const action = actionFor(this.opts.adapter, phase);
      try {
        // 变更边界前确认仍持有执行权（被接管则立刻停手，§5.2）。
        await this.opts.lock.assertOwned();
        const credential = action
          ? (await action(ctx)).credential
          : BOOKKEEPING_PHASES.includes(phase)
            ? task.planDigest
            : phase;
        await this.record(task, phase, credential);
        done.add(phase);
      } catch (error) {
        await this.record(
          task,
          'recovering',
          undefined,
          error instanceof Error ? error.message : String(error),
        );
        // 迁移一旦完成，后续失败不得自动恢复旧快照（§6）。
        const migrated = done.has('migrating') || done.has('switching') || done.has('verifying');
        return this.recover(task, ctx, phase, migrated);
      }
    }
    return { phase: 'committed', checkpoints: done.size };
  }

  private async recover(
    task: UpdateTask,
    ctx: StepContext,
    stage: string,
    migrated: boolean,
  ): Promise<EngineRunResult> {
    try {
      await this.opts.lock.assertOwned();
      const result = await this.opts.adapter.recover(ctx, { stage, detail: stage, migrated });
      const phase: UpdatePhase = result.recovered ? 'recovered' : 'recovery_failed';
      await this.record(task, phase, result.credential, result.detail);
      return {
        phase: result.recovered ? 'recovered' : 'recovery_failed',
        detail: result.detail ?? stage,
        checkpoints: (await this.completedPhases(task)).size,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.record(task, 'recovery_failed', undefined, detail);
      return { phase: 'recovery_failed', detail, checkpoints: 0 };
    }
  }
}

export { assertTransition, canTransition };
export function isTerminal(phase: UpdatePhase): boolean {
  return isTerminalPhase(phase);
}

/** 把已终结阶段的日志投影为运行结果。 */
function terminalResult(phase: UpdatePhase, checkpoints: number): EngineRunResult {
  switch (phase) {
    case 'recovered':
      return { phase: 'recovered', detail: '已恢复', checkpoints };
    case 'recovery_failed':
      return { phase: 'recovery_failed', detail: '恢复失败', checkpoints };
    case 'blocked':
      return { phase: 'blocked', detail: '策略阻止', checkpoints };
    default:
      return { phase: 'committed', checkpoints };
  }
}
