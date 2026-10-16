/**
 * updater 状态投影（PLAN-github-distribution-and-updates §5.2）。
 *
 * updater 把「当前部署指针 + 正在执行的任务 + 最近结果」写成一份只读快照，放在通道卷上，
 * 供内核更新中心读取（页面渲染不触网、不依赖 updater 在线）。这是**投影**：权威状态仍是
 * updater 独立卷上的日志与部署指针（§5.2），业务库只保存投影。
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { UpdateTaskResult } from '@stackpanel/spec';

export interface UpdaterStatusSnapshot {
  /** 当前部署代次与 digest（取自部署指针）。 */
  generation: number;
  digest: string | null;
  /** 正在执行的任务幂等键；空闲为 null。 */
  activeTask: string | null;
  /** 最近完成的结果（最多若干条，按时间倒序）。 */
  recent: Array<{ idempotencyKey: string; result: UpdateTaskResult }>;
  /** 快照时间。 */
  updatedAt: string;
}

export class FileUpdaterStatus {
  constructor(private readonly filePath: string) {}

  async read(): Promise<UpdaterStatusSnapshot | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as UpdaterStatusSnapshot;
      return typeof parsed.generation === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  async write(snapshot: UpdaterStatusSnapshot): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  static resolve(stateDir: string): FileUpdaterStatus {
    return new FileUpdaterStatus(path.join(stateDir, 'status.json'));
  }
}
