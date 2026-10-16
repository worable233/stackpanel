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
import { FileUpdateJournal } from './journal.ts';
import { ExecutorLock } from './executor-lock.ts';
import { FileUpdateTaskChannel } from './task-channel.ts';
import type { DeploymentAdapter } from './deployment-adapter.ts';
import { composeConfigFromEnv } from './compose-config.ts';
import { ComposeDeploymentAdapter } from './compose-adapter.ts';
import { SpawnCommandRunner } from './command.ts';
import { FileDeploymentPointer } from './deployment-pointer.ts';

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
}

export class Updater {
  private readonly channel: FileUpdateTaskChannel;
  private readonly journal: FileUpdateJournal;
  private readonly lock: ExecutorLock;
  private readonly engine: UpdateEngine;
  private stopping = false;

  constructor(private readonly deps: UpdaterDeps) {
    const { config } = deps;
    this.channel = new FileUpdateTaskChannel(path.join(config.stateDir, 'channel'));
    this.journal = new FileUpdateJournal(path.join(config.stateDir, 'update-journal.jsonl'));
    this.lock = new ExecutorLock({
      filePath: path.join(config.stateDir, 'executor.lock'),
      owner: `${process.env['HOSTNAME'] ?? 'updater'}:${process.pid}`,
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.engine = new UpdateEngine({
      adapter: deps.adapter,
      journal: this.journal,
      lock: this.lock,
      workDir: path.join(config.stateDir, 'work'),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  /** 单轮：认领一个任务并执行；返回是否处理了任务。 */
  async tick(): Promise<boolean> {
    const task = await this.channel.claim(this.deps.config.instanceId);
    if (!task) return false;
    const result = await this.engine.run(task, true);
    await this.channel.complete(task, await this.toTaskResult(task, result));
    return true;
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
      if (!handled) await sleep(this.deps.config.pollIntervalMs);
    }
  }

  stop(): void {
    this.stopping = true;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const adapter = selectAdapter(process.env);
  const updater = new Updater({ config, adapter });
  const shutdown = (): void => updater.stop();
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

// 仅在作为入口直接运行时启动（测试导入本模块不启动循环）。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { FileUpdateTaskChannel } from './task-channel.ts';
export type { StepContext } from './deployment-adapter.ts';
