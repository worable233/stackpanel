import type { FastifyInstance } from 'fastify';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import type { AdminDashboardWidgetMeta } from '@stackpanel/sdk';
import { readFrontendManifest } from '../../lib/frontend.ts';
import { pluginPackageDir } from '../../lib/plugins.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

/** Admin UI extension points exposed to the web shell. */
export async function adminUiRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/ui/widgets',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      const extensions = app.pluginRuntime.getExtensionsWithOwner<AdminDashboardWidgetMeta>(
        EXTENSION_POINTS.adminDashboard,
      );
      return {
        widgets: extensions.map(({ pluginId, implementation }) => ({
          ...implementation,
          pluginId,
        })),
      };
    },
  );

  app.get(
    '/admin/rbac/templates',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      const templates = app.pluginRuntime
        .list()
        .filter((plugin) => plugin.state === 'active')
        .flatMap((plugin) =>
          plugin.permissions.map((permission) => ({ pluginId: plugin.id, permission })),
        );
      return { templates };
    },
  );

  app.get(
    '/admin/ui/actions',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      const actions: Array<{
        pluginId: string;
        id: string;
        label: string;
        permission?: string;
        component: string;
      }> = [];
      for (const plugin of app.pluginRuntime.list()) {
        if (plugin.state !== 'active') continue;
        const manifest = await readFrontendManifest(pluginPackageDir(plugin.id));
        for (const action of manifest?.adminActions ?? []) {
          actions.push({ ...action, pluginId: plugin.id });
        }
      }
      return { actions };
    },
  );
}
