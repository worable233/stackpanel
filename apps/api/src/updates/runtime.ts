/**
 * 升级运行时装配（PLAN-github-distribution-and-updates §5.1、§10）。
 *
 * 把「任务通道根目录」接到实例数据目录，并提供更新中心路由所需的一切依赖：
 * 已验证目录快照（经 {@link resolveCatalogInstallContext}）、更新策略、实例 ID 与
 * 基线代次投影。未配置目录仓时目录快照为 null——更新中心仍可展示本地与策略，但不
 * 发起任何 GitHub 请求（自托管离线）。
 */

import path from 'node:path';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { catalogKernelRefs, type KernelManifest } from '@stackpanel/spec';
import type { CatalogInstallContext } from '../distribution/runtime.ts';
import { resolveCatalogInstallContext } from '../distribution/runtime.ts';
import { fetchAndVerifyKernelManifest } from '../distribution/kernel-source.ts';
import { env } from '../config/env.ts';

/**
 * 测试注入的通道根/实例 ID 覆盖（模仿分发运行时的 `setCatalogRefreshForTest`）。
 * 生产恒为 null；测试可在 import 之后覆盖，避免依赖「先设环境变量再 import」的时序。
 */
let channelRootOverride: string | null = null;
let instanceIdOverride: string | null = null;

/** 测试用：覆盖通道根与实例 ID；不传则清除覆盖。 */
export function setUpdateChannelForTest(options: {
  channelRoot?: string | null;
  instanceId?: string | null;
}): void {
  channelRootOverride = options.channelRoot ?? null;
  instanceIdOverride = options.instanceId ?? null;
}

/**
 * 任务通道根目录。API 与 updater 消费同一实例私有卷：生产里 updater 把它挂到
 * `UPDATER_STATE_DIR/channel`，API 通过 `DISTRIBUTION_UPDATE_CHANNEL_DIR` 指向同一
 * 挂载。缺省落在实例数据目录的 `distribution/update-channel`。
 */
export function updateChannelRoot(): string {
  return (
    channelRootOverride ??
    env.DISTRIBUTION_UPDATE_CHANNEL_DIR ??
    path.join(resolveStackPanelDataDir(), 'distribution', 'update-channel')
  );
}

/** 实例 ID：与 updater 绑定的一致（缺省 `stackpanel`）。 */
export function updateInstanceId(): string {
  return instanceIdOverride ?? env.DISTRIBUTION_UPDATE_INSTANCE_ID ?? 'stackpanel';
}

/** 目录安装/更新上下文；未配置目录仓时为 null（离线）。 */
export async function updateCatalogContext(): Promise<CatalogInstallContext | null> {
  return resolveCatalogInstallContext();
}

/**
 * 取回并验签目录引用的**内核候选清单**（§13-4）。未配置目录、目录无内核引用，或某个
 * 引用下载/验签失败时，跳过该引用（不阻断扩展更新）；返回已验签通过的内核清单集合。
 */
export async function loadKernelCandidates(
  context: CatalogInstallContext,
): Promise<KernelManifest[]> {
  const refs = catalogKernelRefs(context.catalog);
  if (refs.length === 0) return [];
  const manifests: KernelManifest[] = [];
  for (const ref of refs) {
    try {
      const result = await fetchAndVerifyKernelManifest({
        ref,
        cache: context.cache,
        keyring: context.keyring,
        ...(context.token ? { token: context.token } : {}),
        ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
      });
      manifests.push(result.manifest);
    } catch {
      // 单个内核引用不可用不影响扩展求解；内核自动升级仅在有可用签名清单时进行。
    }
  }
  return manifests;
}
