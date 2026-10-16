/**
 * 自动更新决策（PLAN-github-distribution-and-updates §4、§9、§13-6）。
 *
 * 后台任务在目录刷新后按策略判断「是否可自动提交升级任务」。这是**纯决策**：输入是
 * 策略、当前时间、求解产物与是否需要人工授权，输出是「提交 / 跳过（含原因）」。真实
 * 提交仍走 {@link submitUpdateTask}，且求解失败、需人工授权、被 pin/排除、不在维护窗口、
 * 需要内核自动升级但未开启——一律**不自动执行**，宁可留给人工。
 */

import {
  isExcluded,
  pinnedVersionOf,
  withinMaintenanceWindow,
  type UpdatePolicy,
} from './policy.ts';
import type { DeploymentPlan } from '@stackpanel/spec';

export type AutoUpdateDecision =
  | { submit: true; reason: 'eligible' }
  | { submit: false; reason: AutoUpdateSkipReason; detail: string };

export type AutoUpdateSkipReason =
  | 'auto-disabled'
  | 'outside-window'
  | 'no-change'
  | 'requires-authorization'
  | 'kernel-not-auto'
  | 'excluded'
  | 'pinned';

export interface AutoUpdateInput {
  policy: UpdatePolicy;
  /** 计划是否包含内核自身升级（内核与扩展同计划时）。 */
  plan: DeploymentPlan;
  /** 计划是否包含需人工授权的变更（权限增加 / 不可逆迁移）。 */
  requiresAuthorization: boolean;
  /** 计划中是否包含内核升级（targetKernel 已给）。 */
  includesKernel: boolean;
  now: Date;
}

/**
 * 判断能否自动提交。顺序即优先级：先关卡（是否开启自动）、再时间窗、再变更存在性、
 * 再授权与内核开关，最后逐包过滤排除/pin。
 */
export function decideAutoUpdate(input: AutoUpdateInput): AutoUpdateDecision {
  const { policy, plan, now } = input;
  if (!policy.autoUpdate) {
    return { submit: false, reason: 'auto-disabled', detail: '未开启自动更新（默认保守）' };
  }
  if (!withinMaintenanceWindow(policy, now)) {
    return { submit: false, reason: 'outside-window', detail: '当前不在维护窗口内' };
  }
  // 逐包过滤：排除与 pin 的组件不参与自动计划。
  const actionable = plan.packages.filter(
    (pkg) =>
      !isExcluded(policy, pkg.kind, pkg.id) &&
      pinnedVersionOf(policy, pkg.kind, pkg.id) === undefined,
  );
  if (actionable.length === 0 && !input.includesKernel) {
    return { submit: false, reason: 'no-change', detail: '策略过滤后无可自动更新的组件' };
  }
  if (input.includesKernel && !policy.autoUpdateKernel) {
    return {
      submit: false,
      reason: 'kernel-not-auto',
      detail: '计划含内核升级但未开启内核自动更新',
    };
  }
  if (input.requiresAuthorization) {
    return {
      submit: false,
      reason: 'requires-authorization',
      detail: '计划包含权限增加或不可逆迁移，需人工授权',
    };
  }
  return { submit: true, reason: 'eligible' };
}
