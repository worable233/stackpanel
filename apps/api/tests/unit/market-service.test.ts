import { describe, expect, it } from 'vitest';
import { PluginError } from '@stackpanel/sdk';
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
 *   3. 远程安装失败时不触碰活动目录，并把分发异常收敛成稳定错误码。
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
  unregistered: string[];
  /** 跨副本失效广播（kind/action/id）。 */
  notified: Array<{ kind: string; id: string; action: string }>;
}

function harness(
  options: {
    local?: MarketSourcePackage[];
    remote?: MarketPackage[];
    catalogConfigured?: boolean;
    installError?: Error;
    prepared?: boolean;
    localSources?: { enabled: boolean; reason?: string };
    /** 安装前已存在的插件 id（用于区分「首次安装」与「升级」）。 */
    installedPlugins?: string[];
    /** 安装前已存在的主题 id。 */
    installedThemes?: string[];
    /** 激活新定义时抛错（模拟升级失败）。 */
    activateError?: Error;
    /** 注入一份目录刷新服务（status() 读它的 current()/lastFailureInfo()）。 */
    refresh?: Record<string, unknown>;
  } = {},
): Harness {
  const installed: Array<{ kind: string; id: string }> = [];
  const imported: string[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const notified: Array<{ kind: string; id: string; action: string }> = [];
  const events: string[] = [];
  const present = new Set(options.installedPlugins ?? []);
  const themes = new Set(options.installedThemes ?? []);
  const entries = new Map<string, MarketPackage[]>();
  for (const pkg of options.remote ?? []) {
    entries.set(pkg.id, [pkg]);
  }

  const service = new MarketService({
    runtime: {
      has: (id: string) => present.has(id),
      isActive: (id: string) => present.has(id),
      register: async (definition: PluginDefinition) => {
        registered.push(definition.manifest.id);
        events.push(`register:${definition.manifest.version}`);
        present.add(definition.manifest.id);
      },
      unregister: async (id: string) => {
        unregistered.push(id);
        events.push(`unregister:${id}`);
        present.delete(id);
      },
      activate: async (id: string) => {
        if (options.activateError) throw options.activateError;
        registered.push(`active:${id}`);
      },
    },
    prisma: {
      plugin: { upsert: async () => ({}) },
      theme: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          themes.has(where.id) ? { id: where.id } : null,
        create: async ({ data }: { data: { id: string } }) => {
          themes.add(data.id);
          return data;
        },
        update: async ({ data }: { data: { id?: string } }) => data,
      },
    } as never,
    listLocal: async () => options.local ?? [],
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
    catalogRefresh: () =>
      options.refresh
        ? ({
            lastCheckedAt: () => null,
            cooldownRemainingMs: () => 0,
            refresh: async () => ({ resolved: null, failure: null }),
            ...options.refresh,
          } as never)
        : null,
    notifyChange: async (change) => {
      notified.push(change);
    },
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
  return { service, installed, imported, registered, unregistered, notified };
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
    // 每行必须能看出这次安装会走哪条路径：本地源（不受验签）还是已签名目录。
    expect(store?.source).toBe('local');
    expect(analytics?.source).toBe('catalog');
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

  it('目录可用时健康度带出快照序列与过期时间（页面用于显示「装的是哪一版」）', async () => {
    const expiresAt = '2026-12-01T00:00:00.000Z';
    const h = harness({
      refresh: {
        repository: 'acme/catalog',
        channel: 'stable',
        current: () => ({
          snapshot: { expiresAt },
          sequence: 6,
          expired: false,
        }),
        lastFailureInfo: () => null,
      },
    });
    const status = await h.service.status?.();
    expect(status?.catalog.available).toBe(true);
    expect(status?.catalog.sequence).toBe(6);
    expect(status?.catalog.expiresAt).toBe(expiresAt);
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

  it('远程安装失败时把分发异常收敛成稳定错误码，原因只留在 detail', async () => {
    const h = harness({
      catalogConfigured: true,
      installError: new CatalogMarketError('包签名校验失败'),
    });
    const error = await h.service.install('plugin', 'analytics').then(
      () => null,
      (caught: unknown) => caught,
    );
    // ADR-0012：上屏的是码对应的文案，英文 detail 只进日志。
    expect(error).toBeInstanceOf(PluginError);
    expect((error as PluginError).code).toBe('market.sourceUnavailable');
    expect((error as PluginError).status).toBe(502);
    expect((error as PluginError).detail).toContain('包签名校验失败');
  });

  it('条目不在目录 / 兼容门禁 / 限流各自可辨认（运维下一步不同）', async () => {
    const missing = harness({
      catalogConfigured: true,
      installError: new CatalogMarketError('analytics 不在目录中', [], 'not_found'),
    });
    const missingError = await missing.service.install('plugin', 'analytics').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((missingError as PluginError).code).toBe('market.notInCatalog');
    expect((missingError as PluginError).status).toBe(404);

    const blocked = harness({
      catalogConfigured: true,
      installError: new CatalogMarketError(
        '不兼容',
        [{ code: 'incompatible_kernel', detail: '需要内核 >= 0.2.0' }],
        'blocked',
      ),
    });
    const blockedError = await blocked.service.install('plugin', 'analytics').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((blockedError as PluginError).code).toBe('market.packageBlocked');
    expect((blockedError as PluginError).status).toBe(422);
    expect((blockedError as PluginError).detail).toContain('incompatible_kernel');

    const limited = harness({
      catalogConfigured: true,
      installError: new CatalogMarketError('GitHub 429', [], 'fetch', {
        kind: 'rate_limited',
        retryAfterMs: 8000,
      }),
    });
    const limitedError = await limited.service.install('plugin', 'analytics').then(
      () => null,
      (caught: unknown) => caught,
    );
    // 限流要能被界面做成倒计时（ADR-0028），而不是「安装失败请重试」。
    expect((limitedError as PluginError).code).toBe('market.sourceRateLimited');
    expect((limitedError as PluginError).status).toBe(503);
    expect((limitedError as PluginError).retryAfterSeconds).toBe(8);

    // 限流有时被包在「下载失败」里再抛出来：只看最外层就会退化成「网络不可用」。
    const wrapped = harness({
      catalogConfigured: true,
      installError: new CatalogMarketError('下载失败', [], 'fetch', {
        message: 'wrapper',
        cause: { kind: 'rate_limited', retryAfterMs: 3000 },
      }),
    });
    const wrappedError = await wrapped.service.install('plugin', 'analytics').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((wrappedError as PluginError).code).toBe('market.sourceRateLimited');
    expect((wrappedError as PluginError).retryAfterSeconds).toBe(3);
  });

  it('未配置目录时安装远程条目给出明确拒绝', async () => {
    const h = harness({ catalogConfigured: false });
    const error = await h.service.install('plugin', 'analytics').then(
      () => null,
      (caught: unknown) => caught,
    );
    // 以前这里是普通 Error → 500。现在给稳定码，界面才能说「去配置分发源」。
    expect(error).toBeInstanceOf(PluginError);
    expect((error as PluginError).code).toBe('market.catalogOffline');
    expect((error as PluginError).status).toBe(409);
  });

  it('刷新目录在冷却期内不发请求，并把剩余等待时间带回界面', async () => {
    let refreshed = 0;
    const throttled = harness({
      refresh: {
        repository: 'acme/catalog',
        channel: 'stable',
        cooldownRemainingMs: () => 4200,
        current: () => ({ snapshot: { expiresAt: '2026-12-01T00:00:00.000Z' }, sequence: 6 }),
        lastFailureInfo: () => null,
        refresh: async () => {
          refreshed += 1;
          return { resolved: null, failure: null };
        },
      },
    });
    const result = await throttled.service.refreshCatalog?.();
    expect(result).toMatchObject({ configured: true, throttled: true, retryAtMs: 4200, sequence: 6 });
    // 冷却期就是限流边界：多一个入口就多一条 GitHub 请求路径。
    expect(refreshed).toBe(0);
  });

  it('刷新目录成功后带回收到的序列', async () => {
    const h = harness({
      refresh: {
        repository: 'acme/catalog',
        channel: 'stable',
        current: () => null,
        lastFailureInfo: () => null,
        refresh: async () => ({
          resolved: { snapshot: { sequence: 7, expiresAt: '2026-12-08T00:00:00.000Z' } },
          failure: null,
        }),
      },
    });
    const result = await h.service.refreshCatalog?.();
    expect(result).toMatchObject({ configured: true, throttled: false, sequence: 7 });
  });

  it('未配置远程目录时刷新是空操作（不假装已刷新）', async () => {
    const h = harness({ catalogConfigured: false });
    const result = await h.service.refreshCatalog?.();
    expect(result).toMatchObject({ configured: false, available: false });
  });

  it('本地主题安装会写主题表，并把首次安装与升级区分开', async () => {
    const fresh = harness({ local: [localPackage('solaris')], installedThemes: [] });
    const created = await fresh.service.install('theme', 'solaris');
    // 首次安装不能报 upgraded=true——安装前主题表里没有这一行。
    expect(created).toMatchObject({ id: 'solaris', source: 'local', upgraded: false });

    const again = harness({ local: [localPackage('solaris')], installedThemes: ['solaris'] });
    const upgraded = await again.service.install('theme', 'solaris');
    expect(upgraded).toMatchObject({ id: 'solaris', source: 'local', upgraded: true });
  });

  it('本地插件升级前已存在时 upgraded=true', async () => {
    const h = harness({
      local: [localPackage('analytics')],
      installedPlugins: ['analytics'],
    });
    const result = await h.service.install('plugin', 'analytics');
    expect(result).toMatchObject({ id: 'analytics', source: 'local', upgraded: true });
    expect(h.unregistered).toEqual(['analytics']);
  });

  it('本地升级激活失败时把旧定义装回运行时（不留半切换状态）', async () => {
    const h = harness({
      local: [localPackage('analytics')],
      installedPlugins: ['analytics'],
      activateError: new Error('激活失败'),
    });
    await expect(h.service.install('plugin', 'analytics')).rejects.toThrow('激活失败');
    // 新定义被卸下后旧定义重新注册——与 ZIP 上传路径同语义。
    expect(h.unregistered).toContain('analytics');
    expect(h.registered.filter((entry) => entry === 'analytics')).toHaveLength(2);
    // 失败路径不得广播「已重载」——其它副本不该被叫去加载一个没装成的版本。
    expect(h.notified).toEqual([]);
  });

  it('安装成功后广播跨副本失效（主题 reload / 插件 reload）', async () => {
    const theme = harness({ local: [localPackage('solaris')] });
    await theme.service.install('theme', 'solaris');
    expect(theme.notified).toEqual([{ kind: 'theme', id: 'solaris', action: 'reload' }]);

    const plugin = harness({ local: [localPackage('analytics')] });
    await plugin.service.install('plugin', 'analytics');
    expect(plugin.notified).toEqual([{ kind: 'plugin', id: 'analytics', action: 'reload' }]);
  });
});
