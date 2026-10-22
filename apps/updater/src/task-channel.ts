/**
 * 升级任务投递通道（PLAN-github-distribution-and-updates §5.1）。
 *
 * API **只提交声明式升级任务**，updater 通过实例私有、带身份认证的通道取得任务；
 * 不向公网提供 Docker 代理或通用命令执行。任务最少绑定实例 ID、基线 generation、
 * 目标摘要、计划摘要、幂等键及授权策略版本（见 `@stackpanel/spec` 的 `UpdateTask`）。
 *
 * 这里定义通道契约（投递 + 认领 + 结果回写），并提供**文件系统**实现：API 与
 * updater 共享一个实例私有目录（同一 compose project 的受管卷）。生产可换成为
 * 带认证的内部端点，但语义不变。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  updateChannelDir,
  updateTaskFileName,
  type UpdateTask,
  type UpdateTaskResult,
} from '@stackpanel/spec';

export interface UpdateTaskChannel {
  /** 投递（幂等：同 idempotencyKey 覆盖写，不重复入队）。 */
  submit(task: UpdateTask): Promise<void>;
  /** 认领下一个待执行任务（无则 null）。 */
  claim(instanceId: string): Promise<UpdateTask | null>;
  /** 回写任务结果投影（业务库侧再消费）。 */
  complete(task: UpdateTask, result: UpdateTaskResult): Promise<void>;
  /** 是否存在待认领任务（只读，不消费）；自升级前据此拒绝与内核迁移并行（§5.2）。 */
  hasPending(instanceId: string): Promise<boolean>;
  /**
   * 归档完整任务声明（认领后、执行前调用）。任务结果只含检查点，恢复入口需要完整任务
   * 才能重建 {@link import('./deployment-adapter.ts').StepContext} 来重试；归档使该信息
   * 在重启后仍可读（不依赖内存）。
   */
  archiveTask(task: UpdateTask): Promise<void>;
  /** 读取已归档任务；不存在则 null。 */
  readArchivedTask(instanceId: string, idempotencyKey: string): Promise<UpdateTask | null>;
  /**
   * 回收「认领后进程消失」的孤儿任务，返回被回收的任务声明。
   *
   * 为什么必需：`claim()` 用 `rename` 把任务从 `inbox/` 挪到 `claimed/`，而只有
   * `complete()` 才会删掉 `claimed/` 里的文件。进程若在执行中途被杀（OOM、
   * `kill -9`、断电、容器重启），任务就**永久留在 `claimed/`**：它不再出现在
   * `inbox/`，`claim()` 永远看不到它，权威日志停在中间阶段，实例卡在维护态。
   *
   * 真机演练用 `docker kill` 复现：任务停在 `migrating`，重启 updater 后
   * 没有任何新日志、也没有任何恢复动作——「检查点续跑」实际不存在。
   *
   * 调用方须在**持有执行权之后**调用（否则会抢走另一个活进程正在跑的任务）。
   * 返回的任务需要调用方自行判断是否可续跑（见 `Updater.tick`）。
   */
  reclaimOrphans(instanceId: string): Promise<UpdateTask[]>;
  /**
   * 把已认领的任务**放回** inbox（不动日志、不写结果）。
   *
   * 用于「本轮不该执行」的情况：例如执行权被另一个副本持有。直接 `complete()`
   * 会写一个假结果，留在 `claimed/` 又会被 `reclaimOrphans()` 反复回收——
   * 正确做法是原样放回，让下一轮重新认领。
   */
  returnToInbox(task: UpdateTask): Promise<void>;
}

const FILE_PATTERN = /\.json$/;

/**
 * 文件系统通道。目录布局由 `@stackpanel/spec` 的 {@link updateChannelDir} 单一来源
 * 决定，保证内核（提交）与 updater（认领/回写）对同一实例私有卷的路径理解一致：
 *   <root>/inbox/<instanceId>/<idempotencyKey>.json      待执行
 *   <root>/claimed/<instanceId>/<idempotencyKey>.json    已认领（防并发）
 *   <root>/results/<instanceId>/<idempotencyKey>.json    结果投影
 */
export class FileUpdateTaskChannel implements UpdateTaskChannel {
  constructor(private readonly root: string) {}

  private inboxDir(instanceId: string): string {
    return updateChannelDir(this.root, 'inbox', instanceId);
  }

  private claimedDir(instanceId: string): string {
    return updateChannelDir(this.root, 'claimed', instanceId);
  }

  private resultsDir(instanceId: string): string {
    return updateChannelDir(this.root, 'results', instanceId);
  }

  /** 归档目录（updater 内部，非通道契约子目录）。 */
  private archiveDir(instanceId: string): string {
    return path.join(this.root, 'archived', instanceId);
  }

  async submit(task: UpdateTask): Promise<void> {
    const dir = this.inboxDir(task.instanceId);
    await mkdir(dir, { recursive: true });
    // 原子写，避免 updater 读到半写任务。
    const target = path.join(dir, updateTaskFileName(task.idempotencyKey));
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(task, null, 2), 'utf8');
    await rename(tmp, target);
  }

  async claim(instanceId: string): Promise<UpdateTask | null> {
    const inbox = this.inboxDir(instanceId);
    let names: string[];
    try {
      names = (await readdir(inbox)).filter((name) => FILE_PATTERN.test(name)).sort();
    } catch {
      return null;
    }
    for (const name of names) {
      const from = path.join(inbox, name);
      const claimed = this.claimedDir(instanceId);
      await mkdir(claimed, { recursive: true });
      const to = path.join(claimed, name);
      try {
        // rename 是原子的：同一任务只会被一个认领者移走。
        await rename(from, to);
      } catch {
        continue; // 已被其它认领者取走。
      }
      return JSON.parse(await readFile(to, 'utf8')) as UpdateTask;
    }
    return null;
  }

  async complete(task: UpdateTask, result: UpdateTaskResult): Promise<void> {
    const dir = this.resultsDir(task.instanceId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, updateTaskFileName(task.idempotencyKey)),
      JSON.stringify(result, null, 2),
      'utf8',
    );
    // 认领文件在结果落盘后移除。
    await rm(path.join(this.claimedDir(task.instanceId), updateTaskFileName(task.idempotencyKey)), {
      force: true,
    });
  }

  async hasPending(instanceId: string): Promise<boolean> {
    try {
      const names = await readdir(this.inboxDir(instanceId));
      return names.some((name) => FILE_PATTERN.test(name));
    } catch {
      return false;
    }
  }

  async archiveTask(task: UpdateTask): Promise<void> {
    const dir = this.archiveDir(task.instanceId);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, updateTaskFileName(task.idempotencyKey));
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(task, null, 2), 'utf8');
    await rename(tmp, target);
  }

  /**
   * 回收孤儿任务：把 `claimed/` 里没有结果文件的任务移回 `inbox/` 并返回声明。
   *
   * 判据是「`claimed/<key>.json` 存在但 `results/<key>.json` 不存在」——有结果
   * 说明任务已正常收尾（只是 `complete()` 删认领文件前崩溃），无需重跑；
   * 无结果说明执行中途消失，需要续跑。
   *
   * 只用文件操作、无额外状态文件：重启后即可自愈，不依赖内存。
   */
  async reclaimOrphans(instanceId: string): Promise<UpdateTask[]> {
    const claimed = this.claimedDir(instanceId);
    let names: string[];
    try {
      names = (await readdir(claimed)).filter((name) => FILE_PATTERN.test(name));
    } catch {
      return [];
    }
    const inbox = this.inboxDir(instanceId);
    const results = this.resultsDir(instanceId);
    const reclaimed: UpdateTask[] = [];
    for (const name of names) {
      if (existsSync(path.join(results, name))) {
        // 已有结果：任务已完成，只是清理认领文件前被杀。补删即可。
        await rm(path.join(claimed, name), { force: true });
        continue;
      }
      try {
        const raw = await readFile(path.join(claimed, name), 'utf8');
        const task = JSON.parse(raw) as UpdateTask;
        await mkdir(inbox, { recursive: true });
        await rename(path.join(claimed, name), path.join(inbox, name));
        reclaimed.push(task);
      } catch {
        // 读到半写文件或已被他人处理：跳过，不影响其它任务。
      }
    }
    return reclaimed;
  }

  async returnToInbox(task: UpdateTask): Promise<void> {
    const name = updateTaskFileName(task.idempotencyKey);
    const claimed = path.join(this.claimedDir(task.instanceId), name);
    const inbox = this.inboxDir(task.instanceId);
    await mkdir(inbox, { recursive: true });
    try {
      await rename(claimed, path.join(inbox, name));
    } catch {
      // 认领文件已不在（被清理或另一轮已处理）：保持幂等，不当作错误。
    }
  }

  async readArchivedTask(instanceId: string, idempotencyKey: string): Promise<UpdateTask | null> {
    try {
      const raw = await readFile(
        path.join(this.archiveDir(instanceId), updateTaskFileName(idempotencyKey)),
        'utf8',
      );
      return JSON.parse(raw) as UpdateTask;
    } catch {
      return null;
    }
  }
}
