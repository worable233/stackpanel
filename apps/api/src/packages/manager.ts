/**
 * 统一包管理门面（PLAN-github-distribution-and-updates §7、§11）。
 *
 * 市场、上传（ZIP）、自动更新、重装**全部调用本门面**，只有来源不同（§7 首段）。
 * 门面把 §7 的 8 步事务落实为可观测的文件系统切换：
 *
 *   resolve → verify → stage → materialize → probe → swap → commit → gc
 *
 * - 上传/远程：来源给出「已解包并验签」的文件集合 → {@link PackageManager.stageFiles}
 * - 市场/本地：来源给出「已完整物化」的产物目录 → {@link PackageManager.swapDirectory}
 *
 * 运行时的 register/activate/probe 由路由层（依赖 Fastify app）承担；本门面只负责
 * **文件事务**与**未引用产物回收**，保证「不得原地覆盖活动目录」、失败可回滚，并给
 * 出统一的目标目录解析，消除各来源各自的 `rm(target)` 覆盖路径。
 *
 * 为避免把内核运行时（Prisma/fastify）拖进契约测试，本模块只依赖 SDK 路径工具。
 */

import path from 'node:path';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import type { StageHandle } from './staging.ts';
import { stageAndSwap, swapInDirectory, StagingError } from './staging.ts';
import { reapTransientArtifacts } from './gc.ts';

export type PackageKind = 'plugin' | 'theme';

/** 安装来源；与契约 `PackageSourceKind` 对齐（这里额外允许测试注入的 `seed`）。 */
export type PackageOrigin = 'market' | 'upload' | 'auto-update' | 'reinstall' | 'seed';

export interface PackageStagingPlan {
  kind: PackageKind;
  id: string;
  /** 活动目录的父目录（暂存/备份/回收都在此完成）。 */
  parent: string;
  /** 目标活动目录。 */
  target: string;
}

/** 插件/主题活动目录（与 `lib/plugins.ts`、`lib/themes.ts` 保持一致）。 */
export function packageDir(kind: PackageKind, id: string): string {
  const root = kind === 'plugin' ? 'plugins' : 'themes';
  return path.join(resolveStackPanelDataDir(), root, id);
}

export class PackageManager {
  /** 解析插件/主题的活动目录与其父目录，供暂存与回收复用。 */
  plan(kind: PackageKind, id: string): PackageStagingPlan {
    const target = packageDir(kind, id);
    return { kind, id, parent: path.dirname(target), target };
  }

  /**
   * 暂存一组**已解包并验签**的文件并原子切换（上传 / 远程 / 重装）。
   * 失败时不触碰活动目录；返回句柄供调用方在 DB 指针提交或运行时激活失败时回滚。
   */
  async stageFiles(
    kind: PackageKind,
    id: string,
    files: Map<string, Uint8Array>,
    options: { prepareStage?: (stage: string) => Promise<void> } = {},
  ): Promise<StageHandle> {
    const { parent, target } = this.plan(kind, id);
    return stageAndSwap({
      parent,
      target,
      files,
      ...(options.prepareStage ? { prepareStage: options.prepareStage } : {}),
    });
  }

  /**
   * 把一个**已完整物化**的产物目录原子切换进来（市场 / 本地来源）。
   * 不做原地 `rm(target)` 覆盖（§7.6）。
   */
  async swapDirectory(kind: PackageKind, id: string, sourceDir: string): Promise<StageHandle> {
    const { parent, target } = this.plan(kind, id);
    return swapInDirectory({ parent, target, sourceDir });
  }

  /**
   * 回收活动目录父目录下**未被引用**的瞬态产物（`.stage-*`/`.backup-*`/
   * `.market-*`/`.upload-*`，§7.6/§7.8）。保守：仅删已知瞬态前缀且超过保留期。
   */
  async gc(
    kind: PackageKind,
    options: { maxAgeMs?: number; now?: () => number } = {},
  ): Promise<string[]> {
    const parent = path.dirname(packageDir(kind, '_'));
    return reapTransientArtifacts(parent, options);
  }

  /** 回收全部（插件 + 主题）瞬态产物。 */
  async gcAll(options: { maxAgeMs?: number; now?: () => number } = {}): Promise<{
    plugins: string[];
    themes: string[];
  }> {
    const [plugins, themes] = await Promise.all([
      this.gc('plugin', options),
      this.gc('theme', options),
    ]);
    return { plugins, themes };
  }
}

export { StagingError };
export type { StageHandle };

/** 进程级共享门面（无状态，可安全复用）。 */
export const packageManager = new PackageManager();
