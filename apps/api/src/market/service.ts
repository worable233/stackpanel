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
import { resolveCatalogInstallContext } from '../distribution/runtime.ts';

/** 市场服务依赖（可注入，便于单元测试）。 */
export interface MarketServiceDeps {
  runtime: Pick<PluginRuntime, 'has' | 'register' | 'unregister' | 'activate'>;
  prisma?: PrismaClient;
  /** 解析已验证的远程目录上下文；未配置目录仓时返回 null（完全离线）。 */
  catalog?: () => Promise<CatalogInstallContext | null>;
  /** 本地包发现（测试可注入固定集合）。 */
  listLocal?: (kind: 'plugin' | 'theme') => Promise<MarketSourcePackage[]>;
  /** 本地安装（测试可注入）。 */
  installLocal?: (kind: 'plugin' | 'theme', id: string) => Promise<{ id: string; version: string }>;
  /** 加载已安装插件定义（测试可注入）。 */
  loadDefinition?: (id: string) => Promise<PluginDefinition>;
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

  constructor(private readonly deps: MarketServiceDeps) {
    this.prisma = deps.prisma ?? getPrisma();
    this.catalog = deps.catalog ?? resolveCatalogInstallContext;
    this.listLocal =
      deps.listLocal ?? ((kind) => (kind === 'plugin' ? listMarketPlugins() : listMarketThemes()));
    this.installLocal =
      deps.installLocal ??
      ((kind, id) => (kind === 'plugin' ? installMarketPlugin(id) : installMarketTheme(id)));
    this.loadDefinition = deps.loadDefinition ?? loadPluginDefinition;
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
    const result = await this.installLocal(kind, id);
    if (kind === 'theme') {
      return { id: result.id, version: result.version, upgraded: false, source: 'local' };
    }
    // 与 ZIP 上传一致：安装后立即 register/activate，无需重启。
    const runtime = this.deps.runtime;
    const upgraded = runtime.has(id);
    if (upgraded) await runtime.unregister(id, { retainData: true });
    const definition = await this.loadDefinition(id);
    await runtime.register(definition);
    await runtime.activate(id);
    return { id: result.id, version: result.version, upgraded, source: 'local' };
  }

  private async installFromCatalog(
    context: CatalogInstallContext,
    kind: 'plugin' | 'theme',
    id: string,
  ): Promise<MarketInstallResult> {
    const prepared = await prepareCatalogInstall(context, kind, id);
    const manifest = prepared.packageManifest as { id: string; name: string; version: string };
    try {
      if (kind === 'plugin') {
        const runtime = this.deps.runtime;
        const upgraded = runtime.has(id);
        if (upgraded) await runtime.unregister(id, { retainData: true });
        const definition = await this.loadDefinition(id);
        await runtime.register(definition);
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
      };
    } catch (err) {
      // 文件已暂存但运行时/DB 未提交：恢复旧目录，避免半切换（§7.6）。
      await prepared.handle.rollback();
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
