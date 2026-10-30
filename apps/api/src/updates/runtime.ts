/**
 * 升级运行时装配（PLAN-github-distribution-and-updates §5.1、§10）。
 *
 * 把「任务通道根目录」接到实例数据目录，并提供更新中心路由所需的一切依赖：
 * 已验证目录快照（经 {@link resolveCatalogInstallContext}）、更新策略、实例 ID 与
 * 基线代次投影。目录源被显式关闭时目录快照为 null——更新中心仍可展示本地与策略，但不
 * 发起任何 GitHub 请求（自托管离线）。
 */

import path from 'node:path';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { catalogKernelRefs, type KernelManifest } from '@stackpanel/spec';
import type { CatalogInstallContext } from '../distribution/runtime.ts';
import { getCatalogRefresh, resolveCatalogInstallContext } from '../distribution/runtime.ts';
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

/** 目录安装/更新上下文；目录源被显式关闭时为 null（离线）。 */
export async function updateCatalogContext(): Promise<CatalogInstallContext | null> {
  return resolveCatalogInstallContext();
}

/**
 * 更新中心看到的目录状态。
 *
 * 页面渲染路径必须能回答「我现在到底能不能检查/求解」，而旧实现只有 `configured: boolean`，
 * 把四种完成不同的事塌缩成一个布尔值：
 * - `unconfigured`：目录源被显式关闭（离线部署，配置问题）；
 * - `pending`：配置了，但本进程还没拿到过任何快照（首次启动，可检查）；
 * - `ready`：有已验证快照（`expired` 单独表达新鲜度）；
 * - `failed`：尝试过且失败（GitHub 不可达 / 验签失败 / 回放拒绝，见 `failure`）。
 */
export type CatalogRuntimeState = 'unconfigured' | 'pending' | 'ready' | 'failed';

export interface CatalogRuntimeSnapshot {
  state: CatalogRuntimeState;
  /** 目录仓（`owner/repo`）；未配置为 null。 */
  repository: string | null;
  channel: 'stable' | 'beta' | null;
  /** 已验证快照序号；无快照为 null。 */
  sequence: number | null;
  /** 快照生成时间（ISO）；无快照为 null。 */
  generatedAt: string | null;
  /** 快照是否已过期；无快照为 null。 */
  expired: boolean | null;
  failure: { kind: string; message: string; retryAt: string | null } | null;
  /** 最近一次真的发起过检查的时间（ISO）；从未检查为 null。 */
  lastCheckedAt: string | null;
  /** 手动检查的剩余冷却（毫秒）；0 表示可立即检查。 */
  cooldownMs: number;
}

/**
 * 读取目录快照的**只读**投影——绝不发起网络请求。
 *
 * 「检查更新」是显式动作（`POST /admin/updates/check`）；首屏渲染、`/status`、市场列表
 * 都只读这份投影，因此重启后的第一屏不会被 GitHub 请求阻塞。
 */
export function readCatalogSnapshot(): CatalogRuntimeSnapshot {
  const service = getCatalogRefresh();
  if (!service) {
    return {
      state: 'unconfigured',
      repository: null,
      channel: null,
      sequence: null,
      generatedAt: null,
      expired: null,
      failure: null,
      lastCheckedAt: null,
      cooldownMs: 0,
    };
  }
  const current = service.current();
  const failure = service.lastFailureInfo();
  const state: CatalogRuntimeState = current ? 'ready' : failure ? 'failed' : 'pending';
  return {
    state,
    repository: service.repository ?? null,
    channel: service.channel ?? null,
    sequence: current?.sequence ?? null,
    generatedAt: current?.snapshot.generatedAt ?? null,
    expired: current?.expired ?? null,
    failure: failure
      ? {
          kind: failure.kind,
          message: failure.message,
          retryAt: failure.retryAt ?? null,
        }
      : null,
    lastCheckedAt: service.lastCheckedAt(),
    cooldownMs: service.cooldownRemainingMs(),
  };
}

/**
 * 取回并验签目录引用的**内核候选清单**（§13-4）。目录源关闭、目录无内核引用，或某个
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
        ...(context.mirror ? { mirror: context.mirror } : {}),
        ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
      });
      manifests.push(result.manifest);
    } catch {
      // 单个内核引用不可用不影响扩展求解；内核自动升级仅在有可用签名清单时进行。
    }
  }
  return manifests;
}
