/**
 * 统一包安装事务（PLAN-github-distribution-and-updates §7、§11）。
 *
 * - {@link PackageManager}：市场/上传/自动更新/重装共用的文件事务门面。
 * - `staging`：暂存 + 原子切换 + 回滚原语。
 * - `gc`：未引用瞬态产物回收。
 */
export { PackageManager, packageManager, packageDir } from './manager.ts';
export type { PackageKind, PackageOrigin, PackageStagingPlan } from './manager.ts';
export { stageAndSwap, swapInDirectory, StagingError } from './staging.ts';
export type { StageHandle } from './staging.ts';
export { reapTransientArtifacts, TRANSIENT_PREFIXES } from './gc.ts';
export type { ReapOptions } from './gc.ts';
