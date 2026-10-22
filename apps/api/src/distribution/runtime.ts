/**
 * 分发运行时单例（PLAN-github-distribution-and-updates §10、§13-4）。
 *
 * 把目录刷新协调器接到内核的实例数据目录与管理员配置上：持久条件请求缓存、
 * 持久防回放 sequence、信任根加载，以及「同一进程共享一次刷新」。页面渲染与路由只
 * 通过本模块只读地取「上次成功的快照」，永不直接请求 GitHub。
 *
 * 未在管理员设置中配置目录仓时返回 null——自托管默认完全离线，后台
 * 任务跳过、不产生任何出网请求。
 */

import path from 'node:path';
import type { CatalogSnapshot, Keyring } from '@stackpanel/spec';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { loadKeyring } from './keyring.ts';
import { FileSourceCache } from './source-cache.ts';
import type { SourceCache } from './github-source.ts';
import { FileCatalogStateStore } from './catalog-state.ts';
import { CatalogRefreshService } from './refresh-service.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { decryptSecret } from '../lib/crypto.ts';

export const MARKET_SOURCE_SETTING_KEY = 'market.catalog';
export const MARKET_SOURCE_SECRET_KEY = 'plugin.market.catalog-token';

let singleton: CatalogRefreshService | null | undefined;
let singletonConfigKey: string | undefined;
/** 测试通过 `setCatalogRefreshForTest` 注入：跳过 DB 来源配置解析。 */
let testInjected = false;

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
  return null;
}

/** Clear the process cache after an administrator changes the source. */
export function resetCatalogRefresh(): void {
  singleton = undefined;
  singletonConfigKey = undefined;
  testInjected = false;
}

/** 仅供测试重置单例。 */
export function resetCatalogRefreshForTest(): void {
  resetCatalogRefresh();
}

/** 仅供测试注入一个已配置的刷新协调器。 */
export function setCatalogRefreshForTest(service: CatalogRefreshService | null): void {
  singleton = service;
  // 注入即视为「来源已配置」：否则 resolveCatalogInstallContext 会先读 DB
  // 设置、发现没有 `market.catalog` 就直接返回 null，把注入的协调器丢掉。
  testInjected = true;
}

/**
 * 组装「远程目录安装」所需依赖（目录已解析快照 + keyring + 缓存），供市场路由使用。
 *
 * - 未配置目录仓 → 返回 `null`（自托管离线，市场只展示本地来源）。
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
  // 测试注入的协调器直接使用：它自带 options/keyring/cache，不需要 DB 来源记录。
  if (!testInjected) {
    const prisma = getPrisma();
    const row = await prisma.setting.findUnique({ where: { key: MARKET_SOURCE_SETTING_KEY } });
    const value = row?.value;
    const config =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const repository = typeof config.repository === 'string' ? config.repository.trim() : '';
    if (!repository) return null;
    const channel = config.channel === 'beta' ? 'beta' : 'stable';
    const ref = typeof config.ref === 'string' && config.ref.trim() ? config.ref.trim() : 'main';
    const secret = await prisma.secret.findUnique({ where: { key: MARKET_SOURCE_SECRET_KEY } });
    let token: string | undefined;
    if (secret?.ciphertext) {
      try {
        token = decryptSecret(secret.ciphertext);
      } catch {
        token = undefined;
      }
    }
    const configKey = `${repository}|${channel}|${ref}|${token ? 'token' : 'no-token'}`;
    if (singletonConfigKey !== configKey) {
      const root = distributionStateDir();
      singleton = new CatalogRefreshService({
        options: { repository, channel, ref, ...(token ? { token } : {}) },
        cache: new FileSourceCache({ rootDir: path.join(root, 'cache') }),
        state: new FileCatalogStateStore(path.join(root, 'catalog-state.json')),
        loadKeyring,
      });
      singletonConfigKey = configKey;
    }
  }
  const service = singleton;
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
