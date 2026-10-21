/**
 * 市场能力服务（PLAN-github-distribution-and-updates §9、ADR-0020 D3）。
 *
 * 市场**业务面**（页面、导航、浏览/安装的 HTTP 编排与审计）由内置插件
 * `market` 承担；内核只保留并暴露**分发安全原语**——本地包发现、已签名远程目录
 * 条目、以及经 {@link PackageManager} 的验签安装事务与运行时激活。
 *
 * 这正是 ADR-0020「内核 = 横切能力服务」的模式：插件通过
 * `ctx.getService('kernel.market')` 消费，内核不注册任何 `/admin/market` 路由。
 *
 * 本服务不解析 HTTP、不写审计、不做权限判断——那些属于插件路由（它持有请求上下文）。
 */

import type { PrismaClient } from '@stackpanel/db';
import type {
  MarketInstallResult,
  MarketPackage,
  MarketService as MarketServiceContract,
  PluginDefinition,
} from '@stackpanel/sdk';
import type { CatalogInstallContext } from '../distribution/runtime.ts';
import type { CatalogRefreshService } from '../distribution/refresh-service.ts';
import type { PluginRuntime } from '../plugins/runtime.ts';
import {
  catalogMarketPackageView,
  installMarketPlugin,
  installMarketTheme,
  listMarketPlugins,
  listMarketThemes,
  marketPackageView,
  type MarketSourcePackage,
} from '../lib/market.ts';
import {
  CatalogMarketError,
  listCatalogMarketEntries,
  prepareCatalogInstall,
  type CatalogKind,
} from '../lib/market-catalog.ts';
import { loadPluginDefinition } from '../lib/plugins.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { getCatalogRefresh, resolveCatalogInstallContext } from '../distribution/runtime.ts';
import {
  localMarketSourcesAllowed,
  localSourcesDisabledReason,
} from '../distribution/runtime-env.ts';

/** 市场来源健康度（供后台展示「为什么没有条目」）。 */
export interface MarketStatus {
  localSources: {
    enabled: boolean;
    reason?: string;
  };
  catalog: {
    /** 是否配置了远程目录（默认源也算配置）。 */
    configured: boolean;
    repository: string | null;
    channel: string | null;
    /** 是否已拿到一份可用快照。 */
    available: boolean;
    sequence?: number;
    expired?: boolean;
    /** 最近一次刷新失败原因（成功后清空）。 */
    failure?: { kind: string; message: string; retryAt?: string };
  };
}

/** 市场服务依赖（可注入，便于单元测试）。 */
export interface MarketServiceDeps {
  runtime: Pick<PluginRuntime, 'has' | 'isActive' | 'register' | 'unregister' | 'activate'>;
  prisma?: PrismaClient;
  /** 解析已验证的远程目录上下文；未配置目录仓时返回 null（完全离线）。 */
  catalog?: () => Promise<CatalogInstallContext | null>;
  /** 本地包发现（测试可注入固定集合）。 */
  listLocal?: (kind: 'plugin' | 'theme') => Promise<MarketSourcePackage[]>;
  /** 本地安装（测试可注入）。 */
  installLocal?: (kind: 'plugin' | 'theme', id: string) => Promise<{ id: string; version: string }>;
  /** 加载已安装插件定义（测试可注入）。 */
  loadDefinition?: (id: string) => Promise<PluginDefinition>;
  /** 本地来源策略（测试可注入；默认按容器/生产形态判定）。 */
  localSources?: () => { enabled: boolean; reason?: string };
  /** 目录刷新协调器（测试可注入；默认读进程单例）。 */
  catalogRefresh?: () => CatalogRefreshService | null;
}

const LOCAL_LABEL: Record<'plugin' | 'theme', string> = { plugin: '插件', theme: '主题' };

/**
 * 市场能力服务：内核保留的**唯一**市场入口。
 *
 * - {@link list} 返回与插件/主题无关的 `MarketPackage[]`（本地优先，同名远程条目不覆盖）。
 * - {@link install} 走统一安装事务：解析 → 验签 → 暂存 → 运行时激活 → 提交/回滚。
 */
export class MarketService implements MarketServiceContract {
  private readonly prisma: PrismaClient;
  private readonly catalog: () => Promise<CatalogInstallContext | null>;
  private readonly listLocal: (kind: 'plugin' | 'theme') => Promise<MarketSourcePackage[]>;
  private readonly installLocal: (
    kind: 'plugin' | 'theme',
    id: string,
  ) => Promise<{ id: string; version: string }>;
  private readonly loadDefinition: (id: string) => Promise<PluginDefinition>;
  private readonly localSources: () => { enabled: boolean; reason?: string };
  private readonly catalogRefresh: () => CatalogRefreshService | null;

  constructor(private readonly deps: MarketServiceDeps) {
    this.prisma = deps.prisma ?? getPrisma();
    this.catalog = deps.catalog ?? resolveCatalogInstallContext;
    this.listLocal =
      deps.listLocal ?? ((kind) => (kind === 'plugin' ? listMarketPlugins() : listMarketThemes()));
    this.installLocal =
      deps.installLocal ??
      ((kind, id) => (kind === 'plugin' ? installMarketPlugin(id) : installMarketTheme(id)));
    this.loadDefinition = deps.loadDefinition ?? loadPluginDefinition;
    this.localSources =
      deps.localSources ??
      (() =>
        localMarketSourcesAllowed()
          ? { enabled: true }
          : { enabled: false, reason: localSourcesDisabledReason() });
    this.catalogRefresh = deps.catalogRefresh ?? getCatalogRefresh;
  }

  /** 列出某类可安装条目：本地随包来源 + 已签名远程目录（若配置）。 */
  async list(kind: 'plugin' | 'theme'): Promise<MarketPackage[]> {
    const local = await Promise.all(
      (await this.listLocal(kind)).map((source) => marketPackageView(kind, source)),
    );
    const context = await this.catalog().catch(() => null);
    if (!context) return sortByKey(local);
    const entries = await listCatalogMarketEntries(context.catalog, kind as CatalogKind);
    const remote = entries.map((entry) => catalogMarketPackageView(entry, entry.installedVersion));
    return mergeMarket(local, remote);
  }

  /**
   * 市场来源健康度：本地来源是否可用、远程目录是否配置/可用，以及失败原因。
   *
   * 默认远程源开启后，「目录取不到」和「本地来源被容器策略禁用」都会让市场看起来
   * 是空的；没有这份诊断，运维只能猜。**不发网络请求**，只读当前状态。
   */
  async status(): Promise<MarketStatus> {
    const local = this.localSources();
    const service = this.catalogRefresh();
    const current = service?.current() ?? null;
    const failure = service?.lastFailureInfo() ?? null;
    return {
      localSources: local,
      catalog: {
        configured: service !== null,
        repository: service?.repository ?? null,
        channel: service?.channel ?? null,
        available: current !== null,
        ...(current ? { sequence: current.sequence, expired: current.expired } : {}),
        ...(failure ? { failure } : {}),
      },
    };
  }

  /**
   * 安装/升级一个条目。本地来源优先（即随内核发布的包）；否则从已签名目录安装。
   * 任何验签/兼容/事务失败都不触碰活动目录，抛出的错误由插件路由转成明确拒绝。
   */
  async install(kind: 'plugin' | 'theme', id: string): Promise<MarketInstallResult> {
    const local = (await this.listLocal(kind)).find((source) => source.id === id);
    if (local) return this.installFromLocal(kind, id);

    const context = await this.catalog();
    if (!context) {
      throw new CatalogMarketError(`未配置远程目录，无法从目录安装${LOCAL_LABEL[kind]}：${id}`);
    }
    return this.installFromCatalog(context, kind, id);
  }

  private async installFromLocal(
    kind: 'plugin' | 'theme',
    id: string,
  ): Promise<MarketInstallResult> {
    // `upgraded` 必须在安装**之前**判定：安装会把 DB 行从「无」变成「有」，
    // 事后再查会把首次安装误报成升级。
    const upgraded = await this.wasInstalled(kind, id);
    const result = await this.installLocal(kind, id);
    if (kind === 'theme') {
      return { id: result.id, version: result.version, upgraded, source: 'local' };
    }
    // 与 ZIP 上传一致：安装后立即 register/activate，无需重启。
    const runtime = this.deps.runtime;
    const previousDefinition = upgraded ? await this.loadDefinition(id).catch(() => null) : null;
    const wasActive = upgraded && runtime.isActive(id);
    let oldUnregistered = false;
    let newRegistered = false;
    try {
      if (upgraded) {
        await runtime.unregister(id, { retainData: true });
        oldUnregistered = true;
      }
      const definition = await this.loadDefinition(id);
      await runtime.register(definition);
      newRegistered = true;
      await runtime.activate(id);
    } catch (err) {
      // 文件已经是新的，但新定义没跑起来：把旧定义装回去，别让路由静默消失。
      if (newRegistered) await runtime.unregister(id, { retainData: true }).catch(() => undefined);
      if (oldUnregistered && previousDefinition) {
        await runtime.register(previousDefinition).catch(() => undefined);
        if (wasActive) await runtime.activate(id).catch(() => undefined);
      }
      throw err;
    }
    return { id: result.id, version: result.version, upgraded, source: 'local' };
  }

  /** 该组件是否已安装（插件看运行时，主题看主题表）。 */
  private async wasInstalled(kind: 'plugin' | 'theme', id: string): Promise<boolean> {
    if (kind === 'plugin') return this.deps.runtime.has(id);
    const row = await this.prisma.theme.findUnique({ where: { id }, select: { id: true } });
    return row !== null;
  }

  private async installFromCatalog(
    context: CatalogInstallContext,
    kind: 'plugin' | 'theme',
    id: string,
  ): Promise<MarketInstallResult> {
    const prepared = await prepareCatalogInstall(context, kind, id);
    const manifest = prepared.packageManifest as { id: string; name: string; version: string };
    const runtime = this.deps.runtime;
    // 升级前先记下运行中的旧定义与激活状态：装载新定义失败时必须把它装回去，
    // 否则文件回滚了、进程里却没有这个插件——路由静默消失，比升级失败更难查。
    const wasRegistered = kind === 'plugin' && runtime.has(id);
    const previousDefinition = wasRegistered ? await this.loadDefinition(id).catch(() => null) : null;
    const wasActive = wasRegistered && runtime.isActive(id);
    let oldUnregistered = false;
    let newRegistered = false;
    try {
      if (kind === 'plugin') {
        if (wasRegistered) {
          await runtime.unregister(id, { retainData: true });
          oldUnregistered = true;
        }
        const definition = await this.loadDefinition(id);
        await runtime.register(definition);
        newRegistered = true;
        await runtime.activate(id);
        await this.prisma.plugin.upsert({
          where: { id },
          create: {
            id,
            name: manifest.name,
            version: manifest.version,
            enabled: true,
          },
          update: { name: manifest.name, version: manifest.version },
        });
      } else {
        const existing = await this.prisma.theme.findUnique({ where: { id } });
        if (existing) {
          await this.prisma.theme.update({
            where: { id },
            data: { name: manifest.name, version: manifest.version },
          });
        } else {
          await this.prisma.theme.create({
            data: { id, name: manifest.name, version: manifest.version, active: false },
          });
        }
      }
      await prepared.handle.commit();
      return {
        id,
        version: prepared.version,
        upgraded: prepared.upgraded,
        source: 'catalog',
        publisher: prepared.publisher,
        keyId: prepared.keyId,
      };
    } catch (err) {
      // 文件已暂存但运行时/DB 未提交：恢复旧目录，避免半切换（§7.6）。
      await prepared.handle.rollback();
      // 与 ZIP 上传路径对齐：把旧定义装回去，别留下「文件是旧的、进程里没有它」。
      if (newRegistered) await runtime.unregister(id, { retainData: true }).catch(() => undefined);
      if (oldUnregistered && previousDefinition) {
        await runtime.register(previousDefinition).catch(() => undefined);
        if (wasActive) await runtime.activate(id).catch(() => undefined);
      }
      throw err;
    }
  }
}

/** 本地来源优先；同名远程条目不覆盖本地（本地即内置/随包发布）。 */
function mergeMarket(local: MarketPackage[], remote: MarketPackage[]): MarketPackage[] {
  const ids = new Set(local.map((pkg) => pkg.id));
  return sortByKey([...local, ...remote.filter((pkg) => !ids.has(pkg.id))]);
}

function sortByKey(packages: MarketPackage[]): MarketPackage[] {
  return packages.sort((a, b) => a.id.localeCompare(b.id));
}
