/**
 * 离线演练入口（PLAN-github-distribution-and-updates §13-7）。
 *
 * `scripts/release/updater-drill.mjs` 用这个入口在**不接触真实 Docker** 的情况下，把
 * 完整的「干净机器」升级链路跑一遍：真实 {@link UpdateEngine} + 真实
 * {@link ComposeDeploymentAdapter}，只把宿主命令执行换成可注入的假 runner。它验证：
 *
 *   - 九步成功路径推进到 `committed`，部署指针 generation 递增；
 *   - 迁移后失败走恢复且**不**自动恢复旧快照（§6）；
 *   - 迁移前失败允许恢复快照（§6）。
 *
 * 真实 Docker/Compose 的端到端证据仍属 §13-7，需真机与发布镜像。
 */

export { UpdateEngine, isTerminal, assertTransition, canTransition } from './engine.ts';
export type { EngineOptions, EngineRunResult } from './engine.ts';
export { ExecutorLock, ExecutorLockError } from './executor-lock.ts';
export { FileUpdateJournal } from './journal.ts';
export { FileUpdateTaskChannel } from './task-channel.ts';
export {
  ComposeDeploymentAdapter,
  ComposeSelfUpdateAdapter,
  DeploymentAdapterError,
  normalizeDigest,
} from './compose-adapter.ts';
export type { ComposeAdapterOptions, Probe } from './compose-adapter.ts';
export { validateComposeConfig, composeConfigFromEnv } from './compose-config.ts';
export type { ComposeProjectConfig } from './compose-config.ts';
export { FileDeploymentPointer } from './deployment-pointer.ts';
export { FileSnapshotStore } from './snapshot-store.ts';
export { FileUpdaterStatus } from './status.ts';
export { RecoveryCoordinator, MAX_AUTO_RETRIES } from './recovery-actions.ts';
export type { RecoveryCoordinatorDeps, RecoveryActionResult } from './recovery-actions.ts';
export {
  SelfUpdateExecutor,
  SelfUpdateError,
  FileSelfUpdatePlan,
  FileSelfUpdateRequest,
  imagesMatch,
} from './self-update-executor.ts';
export type {
  SelfUpdateAdapter,
  SelfUpdatePlan,
  SelfUpdatePhase,
  SelfUpdateRequest,
  SelfUpdateResult,
  SelfUpdateExecutorDeps,
} from './self-update-executor.ts';
export { SpawnCommandRunner } from './command.ts';
export type { CommandRunner, CommandRequest, CommandResult } from './command.ts';
