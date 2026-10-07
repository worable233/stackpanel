import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  installMarketPlugin,
  installMarketTheme,
  listMarketPlugins,
  listMarketThemes,
  marketPackageView,
} from '../../lib/market.ts';
import { loadPluginDefinition } from '../../lib/plugins.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const marketIdSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * Local application market: browse and install the official plugins and themes
 * shipped with the kernel. Self-hosted installations get a one-click install
 * flow without needing to upload ZIPs manually.
 */
export async function adminMarketRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/market/plugins',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      const sources = await listMarketPlugins();
      const plugins = await Promise.all(
        sources.map((source) => marketPackageView('plugin', source)),
      );
      return { plugins };
    },
  );

  app.get(
    '/admin/market/themes',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      const sources = await listMarketThemes();
      const themes = await Promise.all(sources.map((source) => marketPackageView('theme', source)));
      return { themes };
    },
  );

  app.post(
    '/admin/market/plugins/:id/install',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const params = marketIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '插件 ID 无效' });
      const { id } = params.data;
      try {
        const result = await installMarketPlugin(id);
        // Register and activate the freshly installed plugin at runtime so it
        // takes effect without a restart (same live behavior as ZIP upload).
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
          meta: { version: result.version },
          ...auditContext(request),
        });
        return reply.code(201).send({
          installed: true,
          upgraded,
          id: result.id,
          version: result.version,
        });
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    },
  );

  app.post(
    '/admin/market/themes/:id/install',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const params = marketIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '主题 ID 无效' });
      const { id } = params.data;
      try {
        const result = await installMarketTheme(id);
        await writeAudit({
          action: 'market.theme.install',
          resource: 'theme',
          resourceId: id,
          meta: { version: result.version },
          ...auditContext(request),
        });
        return reply.code(201).send({
          installed: true,
          upgraded: false,
          id: result.id,
          version: result.version,
        });
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    },
  );
}
