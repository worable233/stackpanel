/**
 * 自举执行的 CLI 桥接（审计 R2、R3）。
 *
 * 职责边界：
 * - `runBootstrap`（bootstrap.ts）只管「状态机 + 迁移 + 配置提升 + 进程重建」，
 *   可脱离文件通道单测；
 * - 本文件管「从通道认领一个任务、抢实例锁、把结果写回」，是 systemd 的入口。
 *
 * 顺序是刻意的：
 * 1. **先抢实例锁**，再认领任务。反过来会出现两个 runner 各抢到一个任务、
 *    然后并行改配置；锁失败时任务必须留在 inbox，等锁释放后 path unit 再唤醒。
 * 2. 认领 = 把文件从 inbox rename 到 claimed。path unit 监听的是 inbox，
 *    因此**任务一被认领就不再触发**，失败也不会形成重启循环（审计 R3）。
 * 3. 无论成功失败都写 results 并清理 claimed：留下 claimed 会让
 *    `--requeue` 之类的恢复动作把已失败的任务又推回去。
 */

import { SpawnCommandRunner, type CommandRunner } from '../command.ts';
import { ExecutorLock } from '../executor-lock.ts';
import type { RunnerLayout } from './layout.ts';
import { runBootstrap } from './bootstrap.ts';
import {
  bootstrapChannelPaths,
  claimFirstBootstrapTask,
  finishBootstrapTask,
} from './bootstrap-channel.ts';
import { readBootstrapState } from './bootstrap.ts';

export interface BootstrapCommandOptions {
  layout: RunnerLayout;
  runner?: CommandRunner;
  pm2Bin?: string;
  pm2Home?: string;
  probe?: (url: string, timeoutMs?: number) => Promise<boolean>;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * 执行一次自举。返回退出码：0 = 无任务或成功；1 = 任务失败。
 *
 * 「无任务」返回 0 是必要的：path unit 有时会在任务已被处理后又唤醒一次
 * （例如 daemon-reload 或开机重扫），这不是错误。
 */
export async function bootstrapCommand(options: BootstrapCommandOptions): Promise<number> {
  const { layout } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((m: string) => console.info(`[bootstrap] ${m}`));

  const channel = bootstrapChannelPaths(layout.stateDir, layout.instanceId);

  const lock = new ExecutorLock({
    filePath: layout.lockFile,
    owner: `${process.env['HOSTNAME'] ?? 'stackpanel'}:${process.pid}`,
    now,
  });
  try {
    await lock.acquire();
  } catch (error) {
    log(
      `另一个执行者持有实例锁，跳过本次唤醒：${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const claimed = await claimFirstBootstrapTask(channel);
    if (!claimed) {
      // 崩溃窗口恢复：API 先写 `queued` 状态、再写任务文件。如果进程在两者
      // 之间退出（或任务文件写失败），inbox 是空的但状态已经要求执行迁移。
      // 不处理这个窗口，实例会永久卡在 queued —— 没有触发源，也没有报错。
      const disk = await readBootstrapState(layout);
      // 两个崩溃窗口都需要恢复：
      // - `queued`：API 已写状态但任务文件没写成（或进程在两者之间退出）；
      // - `migrating` / `starting`：runner 执行到一半退出，任务已被移出 inbox。
      // 后者尤其重要：没有触发源，实例会永远停在迁移中的状态。
      const resumable =
        disk?.phase === 'queued' ||
        disk?.phase === 'migrating' ||
        disk?.phase === 'starting';
      if (!disk || !resumable) {
        log('没有待处理的自举任务');
        return 0;
      }
      log(`inbox 为空但状态为 ${disk.phase}（generation=${disk.configGeneration}），按恢复路径执行`);
      const recovered = await runBootstrap({
        layout,
        // 与升级路径同样的白名单：runner 只允许调用 pm2 / node / 迁移入口，
        // 不因为"恢复路径"就放宽可执行文件集合。
        runner:
          options.runner ?? new SpawnCommandRunner(['node', process.execPath, 'pm2']),
        ...(options.pm2Bin ? { pm2Bin: options.pm2Bin } : {}),
        ...(options.pm2Home ? { pm2Home: options.pm2Home } : {}),
        ...(options.probe ? { probe: options.probe } : {}),
        expectedGeneration: disk.configGeneration,
        lockHeld: true,
        resume: true,
        now,
        log,
      });
      if (recovered.ok) {
        log(`自举完成（恢复路径）：${recovered.phase}`);
        return 0;
      }
      log(`自举失败（恢复路径）：${recovered.detail}`);
      return 1;
    }
    const { task } = claimed;
    log(`认领自举任务 ${task.id}（generation=${task.configGeneration}）`);

    // 任务与状态必须指向同一版本：两者错位说明安装器/API 之间有旧的写入者。
    const diskState = await readBootstrapState(layout);
    if (!diskState) {
      await finishBootstrapTask(channel, task.id, {
        ok: false,
        phase: 'needs_infra',
        detail: '任务已认领但自举状态不存在',
      });
      return 1;
    }
    if (diskState.targetVersion && diskState.targetVersion !== task.targetVersion) {
      await finishBootstrapTask(channel, task.id, {
        ok: false,
        phase: diskState.phase,
        detail: `任务目标版本 ${task.targetVersion} 与状态 ${diskState.targetVersion} 不一致`,
      });
      return 1;
    }

    // 迁移可能远超锁的失联阈值：执行期间续心跳，避免第二个 runner 误接管。
    heartbeat = setInterval(() => {
      void lock.heartbeat().catch(() => undefined);
    }, 20_000);

    const result = await runBootstrap({
      layout,
      runner:
        options.runner ?? new SpawnCommandRunner(['node', process.execPath, 'pm2']),
      ...(options.pm2Bin ? { pm2Bin: options.pm2Bin } : {}),
      ...(options.pm2Home ? { pm2Home: options.pm2Home } : {}),
      ...(options.probe ? { probe: options.probe } : {}),
      expectedGeneration: task.configGeneration,
      lockHeld: true,
      now,
      log,
    });

    await finishBootstrapTask(channel, task.id, {
      ok: result.ok,
      phase: result.phase,
      ...(result.ok ? {} : { detail: result.detail }),
    });

    if (result.ok) {
      log(`自举完成：${result.phase}`);
      return 0;
    }
    log(`自举失败：${result.detail}`);
    return 1;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await lock.release().catch(() => undefined);
  }
}
