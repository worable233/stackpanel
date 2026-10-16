/**
 * 独立升级执行器（PLAN-github-distribution-and-updates §5、§11）。
 *
 * - {@link FileUpdateJournal}：独立持久卷上的**权威操作日志**（append-only，不倒退）。
 * - {@link ExecutorLock}：有所有者的执行代次 + 跨进程互斥；失联可接管，被接管即停手。
 * - {@link DeploymentAdapter}：仅操作绑定 Compose project 的宿主交互契约（可注入假实现）。
 * - {@link UpdateEngine}：状态机驱动器，记录检查点、断点续跑、失败恢复。
 */

export { FileUpdateJournal } from './journal.ts';
export type { JournalEntry, JournalAppend } from './journal.ts';
export { ExecutorLock, ExecutorLockError } from './executor-lock.ts';
export type { LockInfo, ExecutorLockOptions } from './executor-lock.ts';
export type { DeploymentAdapter, StepContext } from './deployment-adapter.ts';
export { UpdateEngine, isTerminal, assertTransition, canTransition } from './engine.ts';
export type { EngineOptions, EngineRunResult } from './engine.ts';
