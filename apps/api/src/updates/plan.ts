/**
 * 升级任务求解与提交（PLAN-github-distribution-and-updates §4、§5.1、§9）。
 *
 * 更新中心用本模块：
 * 1. 从签名目录得到候选（{@link catalogCandidateSources}），叠加已安装状态与策略，
 *    用 §4 的 {@link resolveDeployment} 求解**完整部署计划**（内核 + builtin + 可选
 *    插件 + 主题 + 依赖 + schema + ABI）。求解失败输出具体阻止原因，**不**默认停用
 *    用户插件来凑兼容。
 * 2. 把计划落成**声明式升级任务** {@link UpdateTask}，经实例私有通道提交给 updater。
 * 3. 读取 updater 回写的结果投影 {@link UpdateTaskResult}，供更新中心展示。
 *
 * 本模块不接触 Docker/DB 迁移；那是 updater 的职责。它只做「求解 + 投递 + 读回」。
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@stackpanel/db';
import {
  UPDATE_PROTOCOL_VERSION,
  buildPlanDigestInput,
  resolveDeployment,
  resolveKernelUpgrade,
  updateChannelDir,
  updateTaskFileName,
  type BlockReasonLike,
  type CandidateSource,
  type CatalogSnapshot,
  type DeploymentPlan,
  type KernelManifest,
  type PlannedPackage,
  type UpdateTask,
  type UpdateTaskResult,
} from '@stackpanel/spec';
import { catalogCandidateSources } from '../distribution/catalog-consumer.ts';
import { kernelCapabilities } from '../distribution/kernel-capabilities.ts';
import { listInstalledComponents } from './installed.ts';
import type { UpdatePolicy } from './policy.ts';

/** 求解产物：要么可执行计划，要么具体的阻止原因（§4）。 */
export type PlanOutcome =
  | {
      ok: true;
      plan: DeploymentPlan;
      task: UpdateTask;
      /** 计划是否包含内核自身升级（目标内核版本不同于当前）。 */
      includesKernel: boolean;
    }
  | { ok: false; blocks: BlockReasonLike[] };

export interface PlanInput {
  prisma: PrismaClient;
  /** 已验证的目录快照。 */
  catalog: CatalogSnapshot;
  policy: UpdatePolicy;
  instanceId: string;
  /** 目标内核摘要（内核升级时）；缺省表示只解扩展。 */
  targetKernel?: {
    version: string;
    digest: string;
    migration: string;
    /** 升级载体（ADR-0025）；缺省 `oci`。 */
    carrier?: 'oci' | 'artifact';
    /** 产物包下载地址（仅 `artifact` 载体）。 */
    url?: string;
    /** 产物包字节数（仅 `artifact` 载体）。 */
    size?: number;
  };
  /**
   * 已验签的内核候选清单（§13-4）。提供则用 {@link resolveKernelUpgrade} 求解内核自身
   * 升级：选中目标内核版本、校验平台镜像、生成迁移路径，并把其 digest/migration 落到
   * 任务。`targetKernel` 显式提供时优先（调用方已求解）。
   */
  kernelCandidates?: KernelManifest[];
  /** 期望的升级载体（ADR-0025）；缺省 `oci`。 */
  carrier?: 'oci' | 'artifact';
  /** 显式目标内核版本（缺省自动选最高可升级版本）。 */
  targetKernelVersion?: string;
  /** 当前部署基线代次（updater 指针投影；缺省 0）。 */
  baselineGeneration: number;
  /** 幂等键；缺省由计划摘要派生（同计划不重复投递）。 */
  idempotencyKey?: string;
  now?: Date;
}

/** 计划摘要（规范化输入 → 稳定哈希）。 */
export function planDigest(plan: DeploymentPlan): string {
  return createHash('sha256').update(JSON.stringify(plan.planDigestInput)).digest('hex');
}

/**
 * 求解完整部署计划并落成任务。**纯求解**：不触碰活动目录、不下载、不切换。
 */
export async function buildUpdatePlan(input: PlanInput): Promise<PlanOutcome> {
  const { prisma, catalog, policy, instanceId } = input;
  const now = input.now ?? new Date();
  const kernel = kernelCapabilities();
  const installed = await listInstalledComponents(prisma, policy);
  const candidates: CandidateSource[] = catalogCandidateSources(catalog);

  // 内核目标：显式 targetKernel 优先；否则若提供内核候选，用 §4 求解器选目标（§13-4）。
  let targetKernel = input.targetKernel;
  if (!targetKernel && input.kernelCandidates && input.kernelCandidates.length > 0) {
    const resolvedKernel = resolveKernelUpgrade({
      currentVersion: kernel.version,
      platform: kernel.platform,
      channel: policy.channel,
      candidates: input.kernelCandidates,
      ...(input.carrier ? { carrier: input.carrier } : {}),
      ...(input.targetKernelVersion ? { targetVersion: input.targetKernelVersion } : {}),
    });
    if (!resolvedKernel.ok) {
      return { ok: false, blocks: resolvedKernel.blocks };
    }
    targetKernel = {
      version: resolvedKernel.target.version,
      digest: resolvedKernel.digest,
      migration: resolvedKernel.target.databaseMigration,
      carrier: resolvedKernel.carrier,
      ...(resolvedKernel.url ? { url: resolvedKernel.url, size: resolvedKernel.size } : {}),
    };
  }

  const resolveInput = {
    kernel,
    installed,
    candidates,
    ...(targetKernel
      ? {
          targetKernel: {
            version: targetKernel.version,
            kernelApi: kernel.kernelApi,
            frontendAbi: kernel.frontendAbi,
            schemaRange: kernel.schemaRange,
            images: [],
          },
        }
      : {}),
  };
  const resolved = resolveDeployment(resolveInput);
  if (!resolved.ok) {
    return { ok: false, blocks: resolved.blocks };
  }

  // 策略过滤：排除自动更新 / 权限增加 / 不可逆迁移仍保留在计划中，但**标记**由调用方
  // 决定是否需要人工授权（§4）。这里不静默丢弃，避免「计划看起来更小」的错觉。
  const packages: PlannedPackage[] = resolved.plan;
  const kernelVersion = resolved.kernelVersion;
  const planDigestInput = buildPlanDigestInput(
    kernelVersion,
    kernel.frontendAbi,
    kernel.schemaRange,
    packages,
  );
  const plan: DeploymentPlan = {
    kernel: targetKernel ?? {
      version: kernelVersion,
      digest: '',
      migration: '',
    },
    packages,
    planDigestInput,
  };
  const digest = planDigest(plan);
  const task: UpdateTask = {
    protocolVersion: UPDATE_PROTOCOL_VERSION,
    instanceId,
    baselineGeneration: input.baselineGeneration,
    targetDigest: plan.kernel.digest,
    planDigest: digest,
    idempotencyKey: input.idempotencyKey ?? digest,
    policyVersion: policyVersion(policy),
    plan,
    createdAt: now.toISOString(),
  };
  const includesKernel =
    targetKernel !== undefined &&
    targetKernel.version !== kernel.version &&
    targetKernel.digest !== '';
  return { ok: true, plan, task, includesKernel };
}

/** 策略版本：策略内容哈希，任何变化都要求重新授权（§5.1）。 */
export function policyVersion(policy: UpdatePolicy): number {
  const canonical = JSON.stringify({
    autoUpdate: policy.autoUpdate,
    channel: policy.channel,
    autoUpdateKernel: policy.autoUpdateKernel,
    excluded: [...policy.excluded].sort(),
    pinned: Object.fromEntries(Object.entries(policy.pinned).sort()),
    allowPermissionIncrease: policy.allowPermissionIncrease,
    allowIrreversibleMigration: policy.allowIrreversibleMigration,
  });
  const hash = createHash('sha256').update(canonical).digest();
  return hash.readUInt32BE(0);
}

/** 计划是否包含需人工授权的变更（权限增加 / 不可逆迁移 / 降级）。 */
export function requiresAuthorization(plan: DeploymentPlan): boolean {
  return plan.packages.some((pkg) => pkg.addsPermissions || !pkg.reversible);
}

/**
 * 提交任务到实例私有通道。文件布局由 spec 单一来源决定，与 updater 认领端一致。
 * 原子写（tmp + rename），避免 updater 读到半写任务。
 */
export async function submitUpdateTask(channelRoot: string, task: UpdateTask): Promise<void> {
  const { mkdir, writeFile, rename } = await import('node:fs/promises');
  const dir = updateChannelDir(channelRoot, 'inbox', task.instanceId);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, updateTaskFileName(task.idempotencyKey));
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(task, null, 2), 'utf8');
  await rename(tmp, target);
}

/** 读取结果投影（若 updater 已回写）。 */
export async function readTaskResult(
  channelRoot: string,
  instanceId: string,
  idempotencyKey: string,
): Promise<UpdateTaskResult | null> {
  const dir = updateChannelDir(channelRoot, 'results', instanceId);
  try {
    const parsed = JSON.parse(
      await readFile(path.join(dir, updateTaskFileName(idempotencyKey)), 'utf8'),
    ) as UpdateTaskResult;
    return typeof parsed.phase === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** 列出某实例的全部结果投影（更新中心历史）。 */
export async function listTaskResults(
  channelRoot: string,
  instanceId: string,
): Promise<Array<{ idempotencyKey: string; result: UpdateTaskResult }>> {
  const dir = updateChannelDir(channelRoot, 'results', instanceId);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: Array<{ idempotencyKey: string; result: UpdateTaskResult }> = [];
  for (const name of names) {
    try {
      const result = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as UpdateTaskResult;
      if (typeof result.phase === 'string') {
        out.push({ idempotencyKey: name.replace(/\.json$/, ''), result });
      }
    } catch {
      // 忽略损坏投影。
    }
  }
  return out;
}
