/**
 * 快照引用（PLAN-github-distribution-and-updates §5.4-4、§6）。
 *
 * 记录「最近一次成功备份」的引用，供失败恢复时判断能否恢复快照。放在 updater 独立卷
 * 上，与部署指针分离——备份与镜像切换是两条独立时间线。
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface SnapshotRef {
  /** 备份目录（含 database.dump）。 */
  ref: string;
  /** 备份时的镜像 digest。 */
  digest: string;
  createdAt: string;
}

export class FileSnapshotStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<SnapshotRef | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as SnapshotRef;
      return typeof parsed.ref === 'string' && typeof parsed.digest === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  async write(ref: SnapshotRef): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(ref, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  static resolve(stateDir: string): FileSnapshotStore {
    return new FileSnapshotStore(path.join(stateDir, 'snapshot-ref.json'));
  }
}
