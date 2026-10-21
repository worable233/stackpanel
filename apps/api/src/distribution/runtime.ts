/**
 * 分发运行时单例（PLAN-github-distribution-and-updates §10、§13-4）。
 *
 * 把目录刷新协调器接到内核的实例数据目录与环境配置上：持久条件请求缓存、
 * 持久防回放 sequence、信任根加载，以及「同一进程共享一次刷新」。页面渲染与路由只
 * 通过本模块只读地取「上次成功的快照」，永不直接请求 GitHub。
 *
 * 目录仓**默认自带**（`DEFAULT_CATALOG_REPOSITORY`）；只有显式设为
 * `off`/`none`/`false` 时 `DISTRIBUTION_CATALOG_REPOSITORY` 才是 undefined，
 * 此时返回 null——完全离线，后台任务跳过、不产生任何出网请求。
 */

import path from 'node:path';
import type { CatalogSnapshot, Keyring } from '@stackpanel/spec';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { env } from '../config/env.ts';
import { loadKeyring } from './keyring.ts';
import { FileSourceCache } from './source-cache.ts';
import type { SourceCache } from './github-source.ts';
import { FileCatalogStateStore } from './catalog-state.ts';
import { CatalogRefreshService } from './refresh-service.ts';

let singleton: CatalogRefreshService | null | undefined;

/** 数据目录下的分发状态根（缓存 + 回放保护）。 */
export function distributionStateDir(): string {
  return path.join(resolveStackPanelDataDir(), 'distribution');
}

/**
 * 进程级共享的目录刷新协调器；目录源被显式关闭时返回 null。
 * 惰性构造：测试导入本模块不会触网，也不会因缺少配置而报错。
 */
export function getCatalogRefresh(): CatalogRefreshService | null {
  if (singleton !== undefined) return singleton;
  const repository = env.DISTRIBUTION_CATALOG_REPOSITORY;
  if (!repository) {
    singleton = null;
    return singleton;
  }
  const root = distributionStateDir();
  singleton = new CatalogRefreshService({
    options: {
      repository,
      channel: env.DISTRIBUTION_CATALOG_CHANNEL,
      ref: env.DISTRIBUTION_CATALOG_REF,
      ...(env.DISTRIBUTION_CATALOG_TOKEN ? { token: env.DISTRIBUTION_CATALOG_TOKEN } : {}),
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
}

/** 仅供测试注入一个已配置的刷新协调器（绕过 env 与单例构造）。 */
export function setCatalogRefreshForTest(service: CatalogRefreshService | null): void {
  singleton = service;
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
    ...(service.fetchImpl ? { fetchImpl: service.fetchImpl } : {}),
    expired: resolved.expired,
  };
}
