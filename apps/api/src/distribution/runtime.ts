/**
 * 分发运行时单例（PLAN-github-distribution-and-updates §10、§13-4）。
 *
 * 把目录刷新协调器接到内核的实例数据目录与环境配置上：持久条件请求缓存、
 * 持久防回放 sequence、信任根加载，以及「同一进程共享一次刷新」。页面渲染与路由只
 * 通过本模块只读地取「上次成功的快照」，永不直接请求 GitHub。
 *
 * 配置有两个来源：后台保存的数据库配置优先，其次环境变量（含内核自带的默认源）。
 * 只有显式关掉（`off`/`none`/`false`）时 `repository` 才是 null，此时返回 null——
 * 完全离线，后台任务跳过、不产生任何出网请求。
 */

import path from 'node:path';
import type { CatalogSnapshot, Keyring } from '@stackpanel/spec';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { loadKeyring } from './keyring.ts';
import { FileSourceCache } from './source-cache.ts';
import type { SourceCache } from './github-source.ts';
import { FileCatalogStateStore } from './catalog-state.ts';
import { CatalogRefreshService } from './refresh-service.ts';
import {
  currentCatalogSourceConfig,
  type CatalogSourceConfig,
} from './source-config.ts';

let singleton: CatalogRefreshService | null | undefined;
/** 构造单例时用的配置指纹；配置变了必须重建，否则后台改完不生效。 */
let singletonKey: string | null = null;
/**
 * 测试注入的协调器优先于配置指纹重建。
 *
 * 没有这个标志位时，`setCatalogRefreshForTest()` 注入的服务会在下一次 `getCatalogRefresh()`
 * 被「配置指纹变了 → 重建」直接丢掉，测试拿到的其实是按真实配置构造的实例（或 null）。
 * 生产恒为 false。
 */
let singletonPinned = false;

/** 数据目录下的分发状态根（缓存 + 回放保护）。 */
export function distributionStateDir(): string {
  return path.join(resolveStackPanelDataDir(), 'distribution');
}

function configKey(config: CatalogSourceConfig): string {
  return JSON.stringify([
    config.repository,
    config.channel,
    config.ref,
    config.mirror,
    config.token,
  ]);
}

/**
 * 进程级共享的目录刷新协调器；目录源被显式关闭时返回 null。
 * 惰性构造：测试导入本模块不会触网，也不会因缺少配置而报错。
 *
 * 配置变更（后台保存）通过指纹比对触发重建：`lastResolved` 会随之丢弃，下一次
 * 取用重新刷新，避免「改了仓库地址但还在用旧快照」。
 */
export function getCatalogRefresh(): CatalogRefreshService | null {
  if (singletonPinned) return singleton ?? null;
  const config = currentCatalogSourceConfig();
  const key = configKey(config);
  if (singleton !== undefined && singletonKey === key) return singleton;

  singletonKey = key;
  if (!config.repository) {
    singleton = null;
    return singleton;
  }
  const root = distributionStateDir();
  singleton = new CatalogRefreshService({
    options: {
      repository: config.repository,
      channel: config.channel,
      ref: config.ref,
      ...(config.token ? { token: config.token } : {}),
      ...(config.mirror ? { mirror: config.mirror } : {}),
    },
    cache: new FileSourceCache({ rootDir: path.join(root, 'cache') }),
    state: new FileCatalogStateStore(path.join(root, 'catalog-state.json')),
    loadKeyring,
  });
  return singleton;
}

/** 仅供测试重置单例。 */
export function resetCatalogRefreshForTest(): void {
  singleton = undefined;
  singletonKey = null;
  singletonPinned = false;
}

/** 仅供测试注入一个已配置的刷新协调器（绕过 env 与单例构造）。 */
export function setCatalogRefreshForTest(service: CatalogRefreshService | null): void {
  singleton = service;
  singletonKey = null;
  singletonPinned = true;
}

/**
 * 组装「远程目录安装」所需依赖（目录已解析快照 + keyring + 缓存），供市场路由使用。
 *
 * - 未配置目录仓（显式关闭） → 返回 `null`（完全离线，市场只展示本地来源）。
 * - 无内存快照时触发一次**实例级合并刷新**（单飞，不并发打 GitHub）。
 * - 目录过期仍可返回快照（展示/人工安装），但调用方可据 `expired` 拒绝自动安装。
 */
export interface CatalogInstallContext {
  catalog: CatalogSnapshot;
  keyring: Keyring;
  cache: SourceCache;
  channel: 'stable' | 'beta';
  token?: string;
  mirror?: string;
  /** 仅测试注入：定制 fetch（生产走全局 fetch）。 */
  fetchImpl?: typeof fetch;
  expired: boolean;
}

export async function resolveCatalogInstallContext(): Promise<CatalogInstallContext | null> {
  const service = getCatalogRefresh();
  if (!service) return null;
  const resolved = await service.ensureCurrent();
  if (!resolved) return null;
  // 与刷新协调器共用同一信任根（而非另取 env/磁盘），保证「刷新信任什么，安装就校验什么」。
  const keyring = await service.loadTrustKeyring();
  return {
    catalog: resolved.snapshot,
    keyring,
    cache: service.cache,
    channel: service.channel,
    ...(service.token ? { token: service.token } : {}),
    ...(service.mirror ? { mirror: service.mirror } : {}),
    ...(service.fetchImpl ? { fetchImpl: service.fetchImpl } : {}),
    expired: resolved.expired,
  };
}
