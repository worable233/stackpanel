/**
 * 自动更新后台任务（PLAN-github-distribution-and-updates §10、§13-6）。
 *
 * 在目录刷新后运行：求解完整部署计划 → 用策略判断是否可自动提交 → 满足则投递到实例
 * 私有通道。**默认关闭**：未开启自动更新、目录源关闭、求解失败或需人工授权时，
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
  describeKernelCandidateFailures,
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
  /** 诊断输出（缺省静默）。自动升级跑在后台，没有 request 上下文。 */
  logger?: { warn: (message: string) => void };
}): Promise<AutoUpdateResult> {
  const now = input.now ?? new Date();
  const context = await updateCatalogContext();
  if (!context) {
    return { submitted: false, reason: 'no-catalog', detail: '未配置远程目录，跳过自动更新' };
  }
  // 过期目录不得据其发起**自动**安装（PLAN §3.3）：缓存可继续展示、人工可决策，
  // 但无人值守地按一份已过期的目录升级生产实例不是可接受的行为。
  if (context.expired) {
    return {
      submitted: false,
      reason: 'catalog-expired',
      detail: '目录快照已过期，跳过自动更新（需刷新目录或人工确认）',
    };
  }
  const policy = await readUpdatePolicy(input.prisma);
  const status = await readUpdaterStatus();
  const kernelCandidates = await loadKernelCandidates(context);
  // 自动升级路径没有 request 上下文，用 logger 注入（缺省静默）。诊断同时进
  // block detail，让界面上的「没有可升级的内核版本」能说清到底哪一步坏了。
  const kernelFailure = describeKernelCandidateFailures(kernelCandidates);
  if (kernelFailure) {
    input.logger?.warn(`内核候选清单不可用：${kernelFailure}`);
  }
  const outcome = await buildUpdatePlan({
    prisma: input.prisma,
    catalog: context.catalog,
    policy,
    instanceId: updateInstanceId(),
    baselineGeneration: status?.generation ?? 0,
    kernelCandidates: kernelCandidates.manifests,
    carrier: env.DISTRIBUTION_UPDATE_CARRIER,
    ...(kernelFailure ? { kernelCandidateFailure: kernelFailure } : {}),
    now,
  });
  if (!outcome.ok) {
    // 把诊断带进 detail：`plan-blocked` 只有「N 项」时，界面看不出是内核候选
    // 全部验签失败还是真的没有更高版本。
    const detail = kernelFailure
      ? `计划被阻止（${outcome.blocks.length} 项）：${kernelFailure}`
      : `计划被阻止（${outcome.blocks.length} 项）`;
    return { submitted: false, reason: 'plan-blocked', detail };
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
