/**
 * 分发运行时单例（PLAN-github-distribution-and-updates §10、§13-4）。
 *
 * 把目录刷新协调器接到内核的实例数据目录与环境配置上：持久条件请求缓存、
 * 持久防回放 sequence、信任根加载，以及「同一进程共享一次刷新」。页面渲染与路由只
 * 通过本模块只读地取「上次成功的快照」，永不直接请求 GitHub。
 *
 * 未配置 `DISTRIBUTION_CATALOG_REPOSITORY` 时返回 null——自托管默认完全离线，后台
 * 任务跳过、不产生任何出网请求。
 */

import path from 'node:path';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { env } from '../config/env.ts';
import { loadKeyring } from './keyring.ts';
import { FileSourceCache } from './source-cache.ts';
import { FileCatalogStateStore } from './catalog-state.ts';
import { CatalogRefreshService } from './refresh-service.ts';

let singleton: CatalogRefreshService | null | undefined;

/** 数据目录下的分发状态根（缓存 + 回放保护）。 */
export function distributionStateDir(): string {
  return path.join(resolveStackPanelDataDir(), 'distribution');
}

/**
 * 进程级共享的目录刷新协调器；未配置目录仓时返回 null。
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
