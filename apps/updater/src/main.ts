/**
 * 独立升级执行器入口（PLAN-github-distribution-and-updates §5.1、§5.2）。
 *
 * 独立、预构建镜像运行；唯一持有 Docker socket；只操作安装时绑定的 Compose
 * project。它**不依赖待升级内核启动**（失败时业务内核仍可提供独立恢复入口）。
 *
 * 本文件把持久日志、执行权、任务通道与部署适配器组装成一个轮询循环。真实 Docker/
 * Compose 适配器由镜像提供（见 `apps/updater/README.md`）；此处默认装配一个
 * **未配置即拒绝**的适配器，避免在未绑定 project 时误操作宿主。
 */

import path from 'node:path';
import type { UpdateTask, UpdateTaskResult } from '@stackpanel/spec';
import { UpdateEngine } from './engine.ts';
import { ExecutorLockError } from './executor-lock.ts';
import { FileUpdateJournal } from './journal.ts';
import { ExecutorLock } from './executor-lock.ts';
import { FileUpdateTaskChannel } from './task-channel.ts';
import type { DeploymentAdapter } from './deployment-adapter.ts';
import { composeConfigFromEnv } from './compose-config.ts';
import { ComposeDeploymentAdapter, ComposeSelfUpdateAdapter } from './compose-adapter.ts';
import { SpawnCommandRunner } from './command.ts';
import { isEntrypoint } from './entrypoint.ts';
import { FileDeploymentPointer } from './deployment-pointer.ts';
import { FileUpdaterStatus } from './status.ts';
import {
  FileHandover,
  FileSelfUpdateState,
  JOURNAL_FORMAT_VERSION,
  assessHandover,
} from './self-update.ts';
import {
  FileSelfUpdatePlan,
  FileSelfUpdateRequest,
  SelfUpdateExecutor,
} from './self-update-executor.ts';
import { createRecoveryServer, type RecoveryServerHandle } from './recovery-entry.ts';
import { RecoveryCoordinator } from './recovery-actions.ts';
import { UPDATE_PROTOCOL_VERSION } from '@stackpanel/spec';

export interface UpdaterConfig {
  /** updater 独立持久卷根（日志/锁/通道）。 */
  stateDir: string;
  /** 绑定的实例 ID；updater 只服务绑定实例（§5.1）。 */
  instanceId: string;
  /** 该实例绑定的 Compose project（不执行包内任意 compose）。 */
  composeProject: string;
  /** 轮询间隔（毫秒）。 */
  pollIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): UpdaterConfig {
  const stateDir = env['UPDATER_STATE_DIR'];
  const instanceId = env['UPDATER_INSTANCE_ID'];
  const composeProject = env['UPDATER_COMPOSE_PROJECT'];
  if (!stateDir || !instanceId || !composeProject) {
    throw new Error(
      'updater 未配置：需要 UPDATER_STATE_DIR / UPDATER_INSTANCE_ID / UPDATER_COMPOSE_PROJECT',
    );
  }
  return {
    stateDir,
    instanceId,
    composeProject,
    pollIntervalMs: Number(env['UPDATER_POLL_INTERVAL_MS'] ?? 5000),
  };
}

/**
 * 未绑定时拒绝执行的适配器。真实实现应在独立镜像里替换它（调用 docker/compose、
 * pg 备份工具），并遵守 §5.1「只操作绑定 project」与 §6 失败兜底矩阵。
 */
export const unconfiguredAdapter: DeploymentAdapter = {
  async download(): Promise<{ credential: string }> {
    throw new Error('部署适配器未配置：无法下载候选镜像');
  },
  async preflight(): Promise<{ credential: string }> {
    throw new Error('部署适配器未配置：无法预检');
  },
  async quiesce(): Promise<{ credential: string }> {
    throw new Error('部署适配器未配置：无法进入维护');
  },
  async snapshot(): Promise<{ credential: string; backupRef: string }> {
    throw new Error('部署适配器未配置：无法备份');
  },
  async migrate(): Promise<{ credential: string }> {
    throw new Error('部署适配器未配置：无法迁移');
  },
  async switchTo(): Promise<{ credential: string }> {
    throw new Error('部署适配器未配置：无法切换');
  },
  async verify(): Promise<{ credential: string }> {
    throw new Error('部署适配器未配置：无法探针验证');
  },
  async commit(): Promise<{ credential: string }> {
    throw new Error('部署适配器未配置：无法提交');
  },
  async cleanup(): Promise<{ credential: string }> {
    throw new Error('部署适配器未配置：无法清理');
  },
  async recover(): Promise<{ recovered: boolean; credential: string }> {
    return { recovered: false, credential: 'adapter-unconfigured' };
  },
};

export interface UpdaterDeps {
  config: UpdaterConfig;
  adapter: DeploymentAdapter;
  /** 注入时间与休眠（测试）。 */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** 日志（测试可注入）。 */
  log?: (message: string) => void;
  /**
   * 本进程的执行权所有者标识（测试可注入）。
   *
   * 缺省 `hostname:pid` 在**单进程内无法模拟「另一个副本」**——两次
   * `new Updater()` 会得到同一个 owner，锁被当成「同进程重复 acquire」而幂等通过。
   * 注入不同 owner 才能在单测里覆盖多副本互斥。
   */
  owner?: string;
  /**
   * 自升级执行器（可选）。启动时确认是否为已提交候选，每轮守卫空闲的 `switching`
   * 计划在候选超时未确认时回退（§5.2）。不注入则完全跳过自升级逻辑。
   */
  selfUpdate?: {
    /**
     * 启动时自确认：若本进程正是计划中的候选 updater 且协议兼容，把计划标记为
     * `committed`。缺了这一步，计划永远停在 `switching`，守护者到点必然回退——
     * 即「自升级永远无法成功」，且症状是「候选明明起来了，5 分钟后被换回去」。
     */
    confirmCandidate: () => Promise<unknown>;
    settleOnStart: () => Promise<unknown>;
    guardTick: () => Promise<unknown>;
    consumeRequest: () => Promise<unknown>;
  };
}

export class Updater {
  private readonly channel: FileUpdateTaskChannel;
  private readonly journal: FileUpdateJournal;
  private readonly lock: ExecutorLock;
  private readonly engine: UpdateEngine;
  private readonly pointer: FileDeploymentPointer;
  private readonly status: FileUpdaterStatus;
  private readonly handover: FileHandover;
  private readonly selfState: FileSelfUpdateState;
  private stopping = false;
  /** 观察到兼容的接管请求后置真：停止认领新任务并释放执行权（§5.2）。 */
  private handedOver = false;

  constructor(private readonly deps: UpdaterDeps) {
    const { config } = deps;
    this.channel = new FileUpdateTaskChannel(path.join(config.stateDir, 'channel'));
    this.journal = new FileUpdateJournal(path.join(config.stateDir, 'update-journal.jsonl'));
    this.lock = new ExecutorLock({
      filePath: path.join(config.stateDir, 'executor.lock'),
      owner: deps.owner ?? `${process.env['HOSTNAME'] ?? 'updater'}:${process.pid}`,
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.engine = new UpdateEngine({
      adapter: deps.adapter,
      journal: this.journal,
      lock: this.lock,
      workDir: path.join(config.stateDir, 'work'),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.pointer = FileDeploymentPointer.resolve(config.stateDir);
    this.status = FileUpdaterStatus.resolve(config.stateDir);
    this.handover = FileHandover.resolve(config.stateDir);
    this.selfState = FileSelfUpdateState.resolve(config.stateDir);
  }

  /** 记录本写入者的协议/日志格式版本，供候选 updater 校验兼容性（§5.2）。 */
  async recordSelfState(): Promise<void> {
    await this.selfState.write({
      protocolVersion: UPDATE_PROTOCOL_VERSION,
      journalFormatVersion: JOURNAL_FORMAT_VERSION,
      writerId: this.lock.owner,
      updatedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
    });
  }

  /**
   * 检查是否有兼容的接管请求；兼容则标记交接（停止认领并在本 tick 结束时释放锁）。
   * 不兼容的请求**不接管**，仅记录——绝不让不兼容版本写同一权威日志。
   */
  async checkHandover(): Promise<void> {
    const request = await this.handover.read();
    if (!request) return;
    const decision = assessHandover({ request, currentOwner: this.lock.owner });
    if (!decision.allow) {
      this.deps.log?.(`拒绝接管请求：${decision.reason}`);
      return;
    }
    if (request.requestedBy === this.lock.owner) return;
    this.deps.log?.(`接受接管请求，释放执行权：${decision.reason}`);
    this.handedOver = true;
  }

  /**
   * 单轮：认领一个任务并执行；返回是否处理了任务。
   *
   * **执行权被他人持有时不算失败**：`engine.run()` 会 `lock.acquire()`，抢不到就抛
   * `ExecutorLockError`。多副本部署下这是**正常状态**（另一个副本正在升级），
   * 必须原地退让、下一轮再试，而不是让进程崩溃。
   *
   * 真机双执行器演练抓到：A 在 B 持锁时抛 `ExecutorLockError` 未捕获，
   * 进程直接退出——一个「为了避免并行」的保护，反而把等待方打死了。
   */
  async tick(): Promise<boolean> {
    if (this.handedOver) return false;
    await this.checkHandover();
    if (this.handedOver) {
      await this.lock.release();
      return false;
    }

    // **先拿执行权，再碰通道。**
    //
    // 顺序至关重要：`reclaimOrphans()` 会把 `claimed/` 里没有结果的任务移回
    // `inbox/`。若在没有执行权时做，就会把**另一个副本正在执行**的任务抢回队列，
    // 造成同一任务被两个进程同时跑（真机双执行器演练抓到：B 正在跑 task-conc-1，
    // A 每轮都把它回收走，两边互相踩）。
    //
    // 抢不到说明别的副本在干活——这是多副本下的正常状态，退让即可。
    try {
      await this.lock.acquire();
    } catch (error) {
      if (error instanceof ExecutorLockError) return false;
      throw error;
    }

    // 到这里为止执行权在本进程手里，`claimed/` 里残留的才是真正的孤儿
    // （原进程已死）。回收后它们会回到 inbox，交给下面正常认领并**按检查点续跑**。
    const reclaimed = await this.channel.reclaimOrphans(this.deps.config.instanceId);
    for (const orphan of reclaimed) {
      this.deps.log?.(`回收孤儿任务：${orphan.idempotencyKey}（将按检查点续跑）`);
    }

    const task = await this.channel.claim(this.deps.config.instanceId);
    if (!task) {
      // 本轮无任务：释放执行权，别占着锁让别的副本空等。
      await this.lock.release();
      return false;
    }
    // 归档完整声明，供独立恢复入口在失败后重建重试任务（不依赖内存）。
    await this.channel.archiveTask(task);
    await this.publishStatus(task.idempotencyKey);
    // `engine.run()` 内部也会 `acquire()`；同一 owner 重复获取是幂等的。
    // 它会在结束时 `release()`，因此这里无需再释放。
    const result = await this.engine.run(task, true);
    const projection = await this.toTaskResult(task, result);
    await this.channel.complete(task, projection);
    await this.publishStatus(null, { idempotencyKey: task.idempotencyKey, result: projection });
    return true;
  }

  /** 写只读状态投影（代次/digest/进行中/最近结果），供更新中心读取（§5.2）。 */
  private async publishStatus(
    activeTask: string | null,
    completed?: { idempotencyKey: string; result: UpdateTaskResult },
  ): Promise<void> {
    const pointer = await this.pointer.read();
    const previous = (await this.status.read())?.recent ?? [];
    const recent = completed
      ? [
          completed,
          ...previous.filter((entry) => entry.idempotencyKey !== completed.idempotencyKey),
        ]
      : previous;
    await this.status.write({
      generation: pointer?.generation ?? 0,
      digest: pointer?.digest ?? null,
      activeTask,
      recent: recent.slice(0, 20),
      updatedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
    });
  }

  /** 把权威日志投影为业务库结果（检查点来自日志，非内存猜测，§5.2）。 */
  private async toTaskResult(
    task: UpdateTask,
    result: { phase: string; detail?: string; checkpoints: number },
  ): Promise<UpdateTaskResult> {
    const entries = await this.journal.forTask(`${task.instanceId}:${task.idempotencyKey}`);
    const checkpoints = entries
      .filter((entry) => entry.phase !== 'recovering' && entry.phase !== 'queued')
      .map((entry) => ({
        phase: entry.phase,
        at: entry.at,
        inputDigest: entry.inputDigest,
        ...(entry.credential !== undefined ? { credential: entry.credential } : {}),
      }));
    return {
      phase: result.phase as UpdateTaskResult['phase'],
      checkpoints,
      ...(result.phase === 'recovered' || result.phase === 'recovery_failed'
        ? {
            recovery: {
              recovered: result.phase === 'recovered',
              detail: result.detail ?? result.phase,
            },
          }
        : {}),
    };
  }

  /** 轮询循环直至 `stop()`。 */
  async run(): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    while (!this.stopping) {
      const handled = await this.tick();
      // 自升级守卫：空闲时检查候选是否超时未确认，超时则回退（§5.2）。
      await this.deps.selfUpdate?.guardTick();
      // 消费管理端提交的自升级请求（无在途计划/任务时）。
      await this.deps.selfUpdate?.consumeRequest();
      if (!handled) await sleep(this.deps.config.pollIntervalMs);
    }
  }

  stop(): void {
    this.stopping = true;
  }

  /** 供独立恢复入口复用的任务通道（重试即重新投递）。 */
  get channelForRecovery(): FileUpdateTaskChannel {
    return this.channel;
  }

  /** 供独立恢复入口复用的权威日志（只读，统计重试次数）。 */
  get journalForRecovery(): FileUpdateJournal {
    return this.journal;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const adapter = selectAdapter(process.env);
  const log = (message: string): void => console.info(`[updater] ${message}`);
  const selfUpdate = selectSelfUpdateExecutor(config, adapter, log);
  const updater = new Updater({ config, adapter, log, ...(selfUpdate ? { selfUpdate } : {}) });
  await updater.recordSelfState();
  // 启动自确认：本进程若正是计划中的候选 updater，先标记 committed，守护者才不会
  // 在候选已正常运行时把它回退掉（此前从未调用，自升级恒在候选超时后回滚）。
  // 不兼容时**不崩溃**：记日志后照常运行，由守护者按截止时间回退到上一镜像。
  try {
    await selfUpdate?.confirmCandidate();
  } catch (error) {
    log(`候选自确认失败，等待守护者回退：${error instanceof Error ? error.message : String(error)}`);
  }
  // 启动对账：若本进程正是已提交候选，清理自升级计划（幂等）。
  await selfUpdate?.settleOnStart();

  // 独立恢复入口（§5.2）：仅在显式配置令牌时监听，默认只回环。
  let recovery: RecoveryServerHandle | null = null;
  const recoveryToken = process.env['UPDATER_RECOVERY_TOKEN'];
  const recoveryPort = Number(process.env['UPDATER_RECOVERY_PORT'] ?? 0);
  const statusStore = FileUpdaterStatus.resolve(config.stateDir);
  const pointerStore = FileDeploymentPointer.resolve(config.stateDir);
  const coordinator = new RecoveryCoordinator({
    instanceId: config.instanceId,
    channel: updater.channelForRecovery,
    journal: updater.journalForRecovery,
    status: statusStore,
    pointer: pointerStore,
    adapter,
    log,
  });
  if (recoveryToken && recoveryPort > 0) {
    recovery = await createRecoveryServer({
      port: recoveryPort,
      host: process.env['UPDATER_RECOVERY_HOST'] ?? '127.0.0.1',
      deps: {
        token: recoveryToken,
        readStatus: async () => {
          const status = await statusStore.read();
          return status
            ? {
                generation: status.generation,
                digest: status.digest,
                activeTask: status.activeTask,
                recent: status.recent,
              }
            : null;
        },
        // 受限动作：重新投递任务 / 回退上一代 / 对账现场；均经执行权与适配器，不绕过
        // 状态机，也不在 HTTP 线程里直接跑变更（§5.2）。
        retry: (idempotencyKey) => coordinator.retry(idempotencyKey),
        rollback: () => coordinator.rollback(),
        reconcile: () => coordinator.reconcile(),
        log,
      },
    });
    log(`恢复入口监听 ${recovery.url}（仅管理网）`);
  }

  const shutdown = (): void => {
    updater.stop();
    void recovery?.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await updater.run();
}

/**
 * 选择部署适配器：绑定配置齐全时用真实 Compose 适配器；否则用**拒绝执行**的默认，
 * 避免未绑定 project 时误操作宿主。真实适配器的装配（compose 目录、镜像仓库、探针）
 * 由 `UPDATER_*` 环境变量提供，见 `apps/updater/README.md`。
 */
export function selectAdapter(env: NodeJS.ProcessEnv = process.env): DeploymentAdapter {
  const bound =
    env['UPDATER_COMPOSE_PROJECT'] && env['UPDATER_IMAGE_REPOSITORY'] && env['UPDATER_STATE_DIR'];
  if (!bound) return unconfiguredAdapter;
  const stateDir = env['UPDATER_STATE_DIR'] as string;
  return new ComposeDeploymentAdapter({
    config: composeConfigFromEnv(env),
    runner: new SpawnCommandRunner(),
    stateDir,
    pointer: FileDeploymentPointer.resolve(stateDir),
  });
}

/**
 * 装配自升级执行器：仅在绑定配置齐全（真实 Compose 适配器）时提供。自升级切换与内核
 * 部署共用同一绑定 project，故复用 `UPDATER_*`。未绑定时返回 null，主循环跳过自升级。
 */
export function selectSelfUpdateExecutor(
  config: UpdaterConfig,
  adapter: DeploymentAdapter,
  log: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): SelfUpdateExecutor | null {
  if (adapter === unconfiguredAdapter) return null;
  const compose = composeConfigFromEnv(env);
  const selfAdapter = new ComposeSelfUpdateAdapter(compose, new SpawnCommandRunner());
  const channel = new FileUpdateTaskChannel(path.join(config.stateDir, 'channel'));
  return new SelfUpdateExecutor({
    adapter: selfAdapter,
    plan: FileSelfUpdatePlan.resolve(config.stateDir),
    // 存在待认领任务时不并行自升级。
    request: FileSelfUpdateRequest.resolve(config.stateDir),
    hasActiveTask: () => channel.hasPending(config.instanceId),
    requestHandover: async (request) => {
      await FileHandover.resolve(config.stateDir).write(request);
    },
    writerId: `${env['HOSTNAME'] ?? 'updater'}:${process.pid}`,
    log,
  });
}

// 仅在作为入口直接运行时启动（测试导入本模块不启动循环）。
if (isEntrypoint(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { FileUpdateTaskChannel } from './task-channel.ts';
export type { StepContext } from './deployment-adapter.ts';
export {
  JOURNAL_FORMAT_VERSION,
  assessHandover,
  FileHandover,
  FileSelfUpdateState,
} from './self-update.ts';
export type { HandoverRequest, HandoverDecision, SelfUpdateState } from './self-update.ts';
export { createRecoveryServer } from './recovery-entry.ts';
export type { RecoveryDeps, RecoveryServerHandle } from './recovery-entry.ts';
export { RecoveryCoordinator, MAX_AUTO_RETRIES } from './recovery-actions.ts';
export type { RecoveryCoordinatorDeps, RecoveryActionResult } from './recovery-actions.ts';
export {
  SelfUpdateExecutor,
  SelfUpdateError,
  FileSelfUpdatePlan,
  FileSelfUpdateRequest,
} from './self-update-executor.ts';
export type {
  SelfUpdateAdapter,
  SelfUpdatePlan,
  SelfUpdatePhase,
  SelfUpdateRequest,
  SelfUpdateResult,
  SelfUpdateExecutorDeps,
} from './self-update-executor.ts';
export { ComposeSelfUpdateAdapter } from './compose-adapter.ts';
