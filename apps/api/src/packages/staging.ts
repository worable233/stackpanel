/**
 * 统一安装事务的 staging/swap 原语（PLAN-github-distribution-and-updates §7.6、§6）。
 *
 * 文件系统不可变目录与数据库不是一个原子事务。硬性要求：
 * - **先把完整产物写入暂存目录**，再整体 `rename` 切换；**不得原地覆盖活动目录**。
 * - 切换前保留旧目录为备份；失败时可回滚到旧版本（原状态不变）。
 * - 失败的暂存/未引用目录由调用方（或 GC）回收。
 *
 * 插件与主题共用本模块，避免「市场直接 `rm(target)`」这类独立覆盖路径（§7 首段）。
 */

import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class StagingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 事务句柄：`commit` 丢弃备份；`rollback` 恢复旧目录。 */
export interface StageHandle {
  /** 目标目录（切换后即活动版本）。 */
  target: string;
  /** 备份目录（存在表示尚未 commit）。 */
  backup: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * 把一组文件物化到暂存目录，再原子切换到目标目录。
 *
 * @param input.parent   活动目录的父目录（暂存/备份都放这里，保证同一文件系统）。
 * @param input.target   目标目录（如 `.../plugins/<id>`）。
 * @param input.files    相对路径 → 字节；路径不得越界。
 * @param input.skipCommit 为 true 时切换后立即删除备份（用于不需要回滚的场景）。
 */
export async function stageAndSwap(input: {
  parent: string;
  target: string;
  files: Map<string, Uint8Array>;
  /** 可选的目录预创建（如插件需要 `dist/`）。 */
  prepareStage?: (stage: string) => Promise<void>;
}): Promise<StageHandle> {
  const { parent, target, files } = input;
  const id = path.basename(target);
  const stage = path.join(parent, `.stage-${id}-${randomUUID()}`);
  const backup = path.join(parent, `.backup-${id}-${randomUUID()}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(parent, { recursive: true });
  await mkdir(stage, { recursive: true });
  if (input.prepareStage) await input.prepareStage(stage);

  // 1) 先把完整产物写入暂存目录（任何失败都不影响活动目录）。
  for (const [name, data] of files.entries()) {
    const resolved = path.resolve(stage, name);
    if (!resolved.startsWith(stage + path.sep)) {
      await rm(stage, { recursive: true, force: true });
      throw new StagingError(422, `非法的文件名：${name}`);
    }
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, data);
  }

  // 2) 原子切换：活动目录先改名为备份，再让暂存目录上位。
  try {
    if (existsSync(target)) await rename(target, backup);
    await rename(stage, target);
  } catch (err) {
    await rm(stage, { recursive: true, force: true });
    if (!existsSync(target) && existsSync(backup)) await rename(backup, target);
    throw err;
  }

  return {
    target,
    backup,
    commit: async () => {
      await rm(backup, { recursive: true, force: true });
    },
    rollback: async () => {
      await rm(target, { recursive: true, force: true });
      if (existsSync(backup)) await rename(backup, target);
    },
  };
}

/**
 * 把一个**已完整物化**的暂存目录整体切换到目标目录，并保留可回滚的备份。
 *
 * 与 {@link stageAndSwap} 的区别：产物已由调用方写成目录（如市场安装先构建
 * `dist/`、`frontend/`、`assets/`）。这里只做「活动目录 → 备份、暂存目录 → 活动
 * 目录」的原子切换和回滚，**不做**原地 `rm(target)` 覆盖（§7.6）。
 */
export async function swapInDirectory(input: {
  parent: string;
  target: string;
  sourceDir: string;
}): Promise<StageHandle> {
  const { parent, target, sourceDir } = input;
  const id = path.basename(target);
  const backup = path.join(parent, `.backup-${id}-${randomUUID()}`);
  await rm(backup, { recursive: true, force: true });
  try {
    if (existsSync(target)) await rename(target, backup);
    await rename(sourceDir, target);
  } catch (err) {
    if (!existsSync(target) && existsSync(backup)) await rename(backup, target);
    throw err;
  }
  return {
    target,
    backup,
    commit: async () => {
      await rm(backup, { recursive: true, force: true });
    },
    rollback: async () => {
      await rm(target, { recursive: true, force: true });
      if (existsSync(backup)) await rename(backup, target);
    },
  };
}
