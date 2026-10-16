/**
 * 升级索引：内核侧「求解 → 投递 → 读回」的统一出口（PLAN-github-distribution-and-updates §4、§5.1、§9）。
 */

export {
  buildUpdatePlan,
  planDigest,
  policyVersion,
  requiresAuthorization,
  submitUpdateTask,
  readTaskResult,
  listTaskResults,
} from './plan.ts';
export type { PlanInput, PlanOutcome } from './plan.ts';
export {
  DEFAULT_UPDATE_POLICY,
  UPDATE_POLICY_SETTING_KEY,
  isExcluded,
  normalizeUpdatePolicy,
  pinnedVersionOf,
  readUpdatePolicy,
  saveUpdatePolicy,
  withinMaintenanceWindow,
} from './policy.ts';
export type { MaintenanceWindow, UpdatePolicy } from './policy.ts';
export { listInstalledComponents, readInstalledComponent } from './installed.ts';
export {
  updateCatalogContext,
  updateChannelRoot,
  updateInstanceId,
  setUpdateChannelForTest,
} from './runtime.ts';
export { readUpdaterStatus } from './status.ts';
export type { UpdaterStatus } from './status.ts';
