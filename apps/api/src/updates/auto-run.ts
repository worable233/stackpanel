/**
 * 自动更新后台任务（PLAN-github-distribution-and-updates §10、§13-6）。
 *
 * 在目录刷新后运行：求解完整部署计划 → 用策略判断是否可自动提交 → 满足则投递到实例
 * 私有通道。**默认关闭**：未开启自动更新、未配置目录仓、求解失败或需人工授权时，
 * 一律不投递（只记录），保持「先验证后执行」与「默认保守」。
 *
 * 本模块与路由共用同一套求解/投递原语（{@link buildUpdatePlan} /
 * {@link submitUpdateTask}），避免后台任务与手动路径产生两份行为。
 */

import type { PrismaClient } from '@stackpanel/db';
import { env } from '../config/env.ts';
import { buildUpdatePlan, requiresAuthorization } from './plan.ts';
import { decideAutoUpdate } from './auto.ts';
import { readUpdatePolicy } from './policy.ts';
import { submitUpdateTask } from './plan.ts';
import { readUpdaterStatus } from './status.ts';
import {
  loadKernelCandidates,
  updateCatalogContext,
  updateChannelRoot,
  updateInstanceId,
} from './runtime.ts';

export interface AutoUpdateResult {
  submitted: boolean;
  reason: string;
  detail?: string;
  idempotencyKey?: string;
}

/**
 * 运行一次自动更新评估。依赖全部可注入，便于单测；生产由内核任务与目录刷新同频调用。
 */
export async function runAutoUpdate(input: {
  prisma: PrismaClient;
  now?: Date;
}): Promise<AutoUpdateResult> {
  const now = input.now ?? new Date();
  const context = await updateCatalogContext();
  if (!context) {
    return { submitted: false, reason: 'no-catalog', detail: '未配置远程目录，跳过自动更新' };
  }
  const policy = await readUpdatePolicy(input.prisma);
  const status = await readUpdaterStatus();
  const kernelCandidates = await loadKernelCandidates(context);
  const outcome = await buildUpdatePlan({
    prisma: input.prisma,
    catalog: context.catalog,
    policy,
    instanceId: updateInstanceId(),
    baselineGeneration: status?.generation ?? 0,
    kernelCandidates,
    carrier: env.DISTRIBUTION_UPDATE_CARRIER,
    now,
  });
  if (!outcome.ok) {
    return {
      submitted: false,
      reason: 'plan-blocked',
      detail: `计划被阻止（${outcome.blocks.length} 项）`,
    };
  }
  const decision = decideAutoUpdate({
    policy,
    plan: outcome.plan,
    requiresAuthorization: requiresAuthorization(outcome.plan),
    includesKernel: outcome.includesKernel,
    now,
  });
  if (!decision.submit) {
    return { submitted: false, reason: decision.reason, detail: decision.detail };
  }
  await submitUpdateTask(updateChannelRoot(), outcome.task);
  return {
    submitted: true,
    reason: decision.reason,
    idempotencyKey: outcome.task.idempotencyKey,
  };
}
