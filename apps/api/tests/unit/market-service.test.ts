import { describe, expect, it } from 'vitest';
import type { MarketPackage, PluginDefinition } from '@stackpanel/sdk';
import { MarketService } from '../../src/market/service.ts';
import { CatalogMarketError } from '../../src/lib/market-catalog.ts';
import type { MarketSourcePackage } from '../../src/lib/market.ts';

/**
 * 市场能力服务单测（ADR-0020 D3 / §9）。
 *
 * 市场业务面已迁到内置插件 `market`；内核只保留这份服务。测试用注入假实现，
 * 验证三件关键语义：
 *   1. 本地来源优先，同名远程条目被忽略（内置包不能被远程覆盖）；
 *   2. 未配置远程目录时完全离线（不假装有远程条目）；
 *   3. 远程安装失败时不触碰活动目录、错误原样上抛。
 */

function localPackage(id: string, version = '1.0.0'): MarketSourcePackage {
  return { id, name: id, version, sourceDir: `/tmp/${id}`, builtin: true };
}

function remotePackage(id: string, version = '2.0.0'): MarketPackage {
  return {
    id,
    name: `${id}-remote`,
    version,
    kind: 'plugin',
    installed: false,
    installedVersion: null,
    upgradable: false,
    current: false,
    builtin: false,
  };
}

interface Harness {
  service: MarketService;
  installed: Array<{ kind: string; id: string }>;
  imported: string[];
  registered: string[];
}

function harness(
  options: {
    local?: MarketSourcePackage[];
    remote?: MarketPackage[];
    catalogConfigured?: boolean;
    installError?: Error;
    prepared?: boolean;
    localSources?: { enabled: boolean; reason?: string };
  } = {},
): Harness {
  const installed: Array<{ kind: string; id: string }> = [];
  const imported: string[] = [];
  const registered: string[] = [];
  const entries = new Map<string, MarketPackage[]>();
  for (const pkg of options.remote ?? []) {
    entries.set(pkg.id, [pkg]);
  }

  const service = new MarketService({
    runtime: {
      has: () => false,
      register: async (definition: PluginDefinition) => {
        registered.push(definition.manifest.id);
      },
      unregister: async () => undefined,
      activate: async (id: string) => {
        registered.push(`active:${id}`);
      },
    },
    prisma: {
      plugin: { upsert: async () => ({}) },
      theme: { findUnique: async () => null, create: async () => ({}), update: async () => ({}) },
    } as never,
    listLocal: async (kind) => (options.local ?? []).filter(() => kind === 'plugin'),
    installLocal: async (kind, id) => {
      installed.push({ kind, id });
      const source = (options.local ?? []).find((pkg) => pkg.id === id);
      return { id, version: source?.version ?? '0.0.0' };
    },
    loadDefinition: async (id) => {
      imported.push(id);
      return { manifest: { id, name: id, version: '1.0.0' } };
    },
    localSources: () => options.localSources ?? { enabled: true },
    catalogRefresh: () => null,
    catalog: async () => {
      if (options.catalogConfigured === false) return null;
      if (options.installError) throw options.installError;
      return {
        catalog: {
          formatVersion: 1,
          sequence: 1,
          generatedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-12-31T00:00:00.000Z',
          channels: [{ channel: 'stable', sequence: 1 }],
          publishers: [],
          entries: Array.from(entries.values()).flatMap((packages) =>
            packages.map((pkg) => ({
              formatVersion: 1,
              kind: 'plugin' as const,
              id: pkg.id,
              version: pkg.version,
              channel: 'stable' as const,
              source: {
                repository: 'acme/plugins',
                tag: `${pkg.id}-v${pkg.version}`,
                asset: 'p.zip',
              },
              artifact: { sha256: 'a'.repeat(64), size: 1 },
              compatibility: {
                kernel: '>=0.2.0',
                kernelApi: '^0.4.0',
                frontendAbi: '^1.0.0',
                packageFormat: 1,
              },
              requires: [],
              conflicts: [],
              permissions: [],
              frontendModes: ['M2'] as const,
              migration: { mode: 'none' as const, rollback: 'code-compatible' as const },
              automatic: { eligible: true },
              publisher: 'acme',
              name: pkg.name,
            })),
          ),
        },
        keyring: { formatVersion: 1, keys: [] },
        cache: {} as never,
        channel: 'stable' as const,
        expired: false,
      };
    },
  });
  return { service, installed, imported, registered };
}

describe('MarketService（内核保留的分发安全原语）', () => {
  it('本地来源优先，同名远程条目不覆盖内置包', async () => {
    const h = harness({
      local: [localPackage('store')],
      remote: [remotePackage('store'), remotePackage('analytics')],
    });
    const packages = await h.service.list('plugin');
    expect(packages.map((pkg) => pkg.id)).toEqual(['analytics', 'store']);
    const store = packages.find((pkg) => pkg.id === 'store');
    expect(store?.version).toBe('1.0.0');
    expect(store?.builtin).toBe(true);
    const analytics = packages.find((pkg) => pkg.id === 'analytics');
    expect(analytics?.version).toBe('2.0.0');
  });

  it('未配置远程目录时完全离线（只返回本地来源）', async () => {
    const h = harness({
      local: [localPackage('store')],
      remote: [remotePackage('analytics')],
      catalogConfigured: false,
    });
    const packages = await h.service.list('plugin');
    expect(packages.map((pkg) => pkg.id)).toEqual(['store']);
  });

  it('来源健康度报告本地来源与目录状态（不发网络请求）', async () => {
    const h = harness({ catalogConfigured: false });
    const status = await h.service.status?.();
    expect(status?.catalog.configured).toBe(false);
    expect(status?.catalog.available).toBe(false);
    expect(status?.catalog.repository).toBeNull();
    expect(status?.localSources).toEqual({ enabled: true });
  });

  it('容器形态下本地来源被禁用时，健康度给出可执行原因', async () => {
    const h = harness({
      catalogConfigured: false,
      localSources: { enabled: false, reason: '本地市场来源在容器/生产形态下已禁用' },
    });
    const status = await h.service.status?.();
    expect(status?.localSources.enabled).toBe(false);
    expect(status?.localSources.reason).toMatch(/容器|生产/);
  });

  it('本地安装后立即注册并激活插件（无需重启）', async () => {
    const h = harness({ local: [localPackage('store-product-card')] });
    const result = await h.service.install('plugin', 'store-product-card');
    expect(result).toMatchObject({
      id: 'store-product-card',
      source: 'local',
      upgraded: false,
    });
    expect(h.registered).toEqual(['store-product-card', 'active:store-product-card']);
    expect(h.installed).toEqual([{ kind: 'plugin', id: 'store-product-card' }]);
  });

  it('远程安装失败时把错误原样上抛（不假装成功）', async () => {
    const h = harness({
      catalogConfigured: true,
      installError: new CatalogMarketError('包签名校验失败'),
    });
    await expect(h.service.install('plugin', 'analytics')).rejects.toThrow('包签名校验失败');
  });

  it('未配置目录时安装远程条目给出明确拒绝', async () => {
    const h = harness({ catalogConfigured: false });
    await expect(h.service.install('plugin', 'analytics')).rejects.toBeInstanceOf(
      CatalogMarketError,
    );
  });
});
