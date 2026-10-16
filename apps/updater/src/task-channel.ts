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
}
