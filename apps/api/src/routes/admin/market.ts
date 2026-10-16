import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MarketPackage } from '@stackpanel/sdk';
import {
  catalogMarketPackageView,
  installMarketPlugin,
  installMarketTheme,
  listMarketPlugins,
  listMarketThemes,
  marketPackageView,
} from '../../lib/market.ts';
import {
  CatalogMarketError,
  listCatalogMarketEntries,
  prepareCatalogInstall,
  type CatalogKind,
} from '../../lib/market-catalog.ts';
import { resolveCatalogInstallContext } from '../../distribution/runtime.ts';
import { loadPluginDefinition } from '../../lib/plugins.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { getPrisma } from '../../plugins/prisma.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const marketIdSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * Application market: browse and install the official plugins and themes shipped
 * with the kernel, plus (when a signed GitHub catalog is configured) remotely
 * published packages. Local sources take precedence; remote entries are only
 * surfaced when `DISTRIBUTION_CATALOG_REPOSITORY` is set and a snapshot exists.
 */
export async function adminMarketRoutes(app: FastifyInstance): Promise<void> {
  /** 远程目录条目的市场视图；未配置目录或没有快照时返回空数组（完全离线）。 */
  async function remotePackages(kind: CatalogKind): Promise<MarketPackage[]> {
    const context = await resolveCatalogInstallContext();
    if (!context) return [];
    const entries = await listCatalogMarketEntries(context.catalog, kind);
    return entries.map((entry) => catalogMarketPackageView(entry, entry.installedVersion));
  }

  app.get(
    '/admin/market/plugins',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      const local = await Promise.all(
        (await listMarketPlugins()).map((source) => marketPackageView('plugin', source)),
      );
      return { plugins: mergeMarket(local, await remotePackages('plugin')) };
    },
  );

  app.get(
    '/admin/market/themes',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      const local = await Promise.all(
        (await listMarketThemes()).map((source) => marketPackageView('theme', source)),
      );
      return { themes: mergeMarket(local, await remotePackages('theme')) };
    },
  );

  app.post(
    '/admin/market/plugins/:id/install',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const params = marketIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '插件 ID 无效' });
      const { id } = params.data;
      const localSource = (await listMarketPlugins()).find((plugin) => plugin.id === id);
      if (localSource) return installLocalPlugin(app, request, reply, id);
      return installRemotePackage(app, request, reply, 'plugin', id);
    },
  );

  app.post(
    '/admin/market/themes/:id/install',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const params = marketIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '主题 ID 无效' });
      const { id } = params.data;
      const localSource = (await listMarketThemes()).find((theme) => theme.id === id);
      if (localSource) return installLocalTheme(request, reply, id);
      return installRemotePackage(app, request, reply, 'theme', id);
    },
  );
}

/** Local market install: copy the shipped package and register it live. */
async function installLocalPlugin(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
): Promise<unknown> {
  try {
    const result = await installMarketPlugin(id);
    // Register and activate the freshly installed plugin at runtime so it takes
    // effect without a restart (same live behavior as ZIP upload).
    const runtime = app.pluginRuntime;
    const upgraded = runtime.has(id);
    if (upgraded) await runtime.unregister(id, { retainData: true });
    const definition = await loadPluginDefinition(id);
    await runtime.register(definition);
    await runtime.activate(id);
    await writeAudit({
      action: 'market.plugin.install',
      resource: 'plugin',
      resourceId: id,
      meta: { version: result.version, source: 'local' },
      ...auditContext(request),
    });
    return reply
      .code(201)
      .send({ installed: true, upgraded, id: result.id, version: result.version });
  } catch (err) {
    return reply.code(409).send({ error: (err as Error).message });
  }
}

/** Local market install for a theme. */
async function installLocalTheme(
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
): Promise<unknown> {
  try {
    const result = await installMarketTheme(id);
    await writeAudit({
      action: 'market.theme.install',
      resource: 'theme',
      resourceId: id,
      meta: { version: result.version, source: 'local' },
      ...auditContext(request),
    });
    return reply
      .code(201)
      .send({ installed: true, upgraded: false, id: result.id, version: result.version });
  } catch (err) {
    return reply.code(409).send({ error: (err as Error).message });
  }
}

/**
 * Remote install from the signed GitHub catalog (unified transaction, §7):
 * resolve → verify (download + keyring-bound signature) → stage →
 * register/activate → commit. On any failure the staged directory is rolled back,
 * leaving the active package intact (§7.6).
 */
async function installRemotePackage(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  kind: CatalogKind,
  id: string,
): Promise<unknown> {
  const context = await resolveCatalogInstallContext();
  if (!context) {
    return reply.code(409).send({ error: '未配置远程目录，无法从目录安装' });
  }
  let prepared;
  try {
    prepared = await prepareCatalogInstall(context, kind, id);
  } catch (err) {
    if (err instanceof CatalogMarketError) {
      return reply.code(409).send({ error: err.message });
    }
    return reply.code(409).send({ error: (err as Error).message });
  }

  const runtime = app.pluginRuntime;
  const prisma = getPrisma();
  const manifest = prepared.packageManifest as { id: string; name: string; version: string };
  try {
    if (kind === 'plugin') {
      const upgraded = runtime.has(id);
      if (upgraded) await runtime.unregister(id, { retainData: true });
      const definition = await loadPluginDefinition(id);
      await runtime.register(definition);
      await runtime.activate(id);
      await prisma.plugin.upsert({
        where: { id },
        create: { id, name: manifest.name, version: manifest.version, enabled: true },
        update: { name: manifest.name, version: manifest.version },
      });
    } else {
      const existing = await prisma.theme.findUnique({ where: { id } });
      if (existing) {
        await prisma.theme.update({
          where: { id },
          data: { name: manifest.name, version: manifest.version },
        });
      } else {
        await prisma.theme.create({
          data: { id, name: manifest.name, version: manifest.version, active: false },
        });
      }
    }
    await prepared.handle.commit();
    await writeAudit({
      action: kind === 'plugin' ? 'market.plugin.install' : 'market.theme.install',
      resource: kind,
      resourceId: id,
      meta: {
        version: prepared.version,
        source: 'catalog',
        publisher: prepared.publisher,
        keyId: prepared.keyId,
      },
      ...auditContext(request),
    });
    return reply.code(prepared.upgraded ? 200 : 201).send({
      installed: true,
      upgraded: prepared.upgraded,
      id,
      version: prepared.version,
    });
  } catch (err) {
    // 文件已暂存但运行时/DB 未提交：恢复旧目录，避免半切换（§7.6）。
    await prepared.handle.rollback();
    return reply.code(409).send({ error: (err as Error).message });
  }
}

/** 本地来源优先；同名远程条目不覆盖本地（本地即内置/随包发布）。 */
function mergeMarket(local: MarketPackage[], remote: MarketPackage[]): MarketPackage[] {
  const ids = new Set(local.map((pkg) => pkg.id));
  return [...local, ...remote.filter((pkg) => !ids.has(pkg.id))].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}
