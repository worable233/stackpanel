import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FrontendManifest } from '@stackpanel/sdk';
import {
  frontendDescriptor,
  resolvedFrontendSettings,
  serveFrontendFile,
  settingsSchemaDescriptor,
} from '../lib/frontend-service.ts';
import { readFrontendManifest } from '../lib/frontend.ts';
import { pluginPackageDir } from '../lib/plugins.ts';
import { rateLimitConfig } from '../lib/rate-limit-policy.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { requireAuth } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';

const pluginIdSchema = z.object({ id: z.string().min(1).max(64) });
const permissionQuerySchema = z.object({ permission: z.string().min(1) });
const frontendAuditSchema = z.object({
  action: z.enum([
    'frontend.finder.call',
    'frontend.admin.route.render',
    'frontend.account.route.render',
    'frontend.action.execute',
  ]),
  pluginId: z.string().min(1).max(64),
  resourceId: z.string().optional(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** Public compiled frontend endpoints for installed plugins. */
export async function pluginRoutes(app: FastifyInstance): Promise<void> {
  app.get('/plugins/frontends', async () => {
    const frontends: Array<{ id: string; manifest: FrontendManifest }> = [];
    for (const plugin of app.pluginRuntime.list()) {
      if (plugin.state !== 'active') continue;
      const manifest = await readFrontendManifest(pluginPackageDir(plugin.id));
      if (manifest) frontends.push({ id: plugin.id, manifest });
    }
    return { plugins: frontends.sort((left, right) => left.id.localeCompare(right.id)) };
  });

  app.get('/permissions/check', { preHandler: requireAuth }, async (request, reply) => {
    const query = permissionQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '权限参数无效' });
    if (!request.user) return reply.code(401).send({ error: '未登录或会话已过期' });
    const allowed = request.user.permissions.has(query.data.permission);
    if (!allowed) {
      await writeAudit({
        action: 'frontend.permission.denied',
        resource: 'permission',
        meta: { permission: query.data.permission },
        ...auditContext(request),
      });
    }
    return { allowed };
  });

  app.post(
    '/frontend/audit',
    {
      preHandler: requireAuth,
      ...rateLimitConfig('userWrite'),
    },
    async (request, reply) => {
      const body = frontendAuditSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: '非法的前台审计事件' });
      if (
        body.data.action === 'frontend.admin.route.render' &&
        !request.user?.permissions.has('platform.admin')
      ) {
        return reply.code(403).send({ error: '权限不足' });
      }
      const installedIds = new Set(app.pluginRuntime.list().map((plugin) => plugin.id));
      if (!installedIds.has(body.data.pluginId)) {
        return reply.code(400).send({ error: '插件不存在' });
      }
      const resource =
        body.data.action === 'frontend.finder.call'
          ? 'frontend.finder'
          : body.data.action === 'frontend.admin.route.render'
            ? 'frontend.admin'
            : body.data.action === 'frontend.account.route.render'
              ? 'frontend.account'
              : 'frontend.action';
      await writeAudit({
        action: body.data.action,
        resource,
        ...(body.data.resourceId ? { resourceId: body.data.resourceId } : {}),
        meta: { pluginId: body.data.pluginId, ...(body.data.meta ?? {}) },
        ...auditContext(request),
      });
      return { ok: true };
    },
  );

  app.get('/plugins/:id/frontend', async (request, reply) => {
    const params = pluginIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '插件 ID 无效' });
    const { id } = params.data;
    if (!app.pluginRuntime.isActive(id) || !existsSync(pluginPackageDir(id))) {
      return reply.code(404).send({ error: '插件不存在' });
    }
    return frontendDescriptor(pluginPackageDir(id));
  });

  /**
   * Expose only the active plugin's actual mutable routes to the web BFF.
   * This lets the host reject a frontend action that tries to target a kernel
   * route or a different plugin before it can use the current session.
   */
  app.get('/plugins/:id/action-targets', { preHandler: requireAuth }, async (request, reply) => {
    const params = pluginIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '插件 ID 无效' });
    const { id } = params.data;
    if (!app.pluginRuntime.isActive(id)) {
      return reply.code(404).send({ error: '插件不存在' });
    }
    const routes = app.pluginDispatcher
      .list()
      .filter((route) => route.pluginId === id)
      .map((route) => ({
        method: route.method,
        path: route.path,
        ...(route.permission ? { permission: route.permission } : {}),
      }));
    return { routes };
  });

  app.get(
    '/plugins/:id/frontend/*',
    { ...rateLimitConfig('publicRead') },
    async (request, reply) => {
      const params = pluginIdSchema.safeParse(request.params);
      const asset = (request.params as { '*': string })['*'];
      if (!params.success || !asset) return reply.code(400).send({ error: '请求参数无效' });
      if (asset.includes('..') || asset.includes('\\')) {
        return reply.code(400).send({ error: '非法的前端路径' });
      }
      const { id } = params.data;
      if (!app.pluginRuntime.isActive(id) || !existsSync(pluginPackageDir(id))) {
        return reply.code(404).send({ error: '插件不存在' });
      }
      return serveFrontendFile(reply, pluginPackageDir(id), asset);
    },
  );

  app.get('/plugins/:id/settings-schema', async (request, reply) => {
    const params = pluginIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '插件 ID 无效' });
    const { id } = params.data;
    if (!existsSync(pluginPackageDir(id))) return reply.code(404).send({ error: '插件不存在' });
    return settingsSchemaDescriptor(pluginPackageDir(id));
  });

  app.get('/plugins/:id/settings', async (request, reply) => {
    const params = pluginIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '插件 ID 无效' });
    const { id } = params.data;
    const packageDir = pluginPackageDir(id);
    if (!existsSync(packageDir)) return reply.code(404).send({ error: '插件不存在' });
    const settings = await resolvedFrontendSettings(getPrisma(), 'plugin', id, packageDir);
    return { settings };
  });
}

/** Validate a frontend file path before it reaches the filesystem. */
export function safeFrontendPath(baseDir: string, asset: string): string {
  const full = path.resolve(baseDir, asset);
  if (!full.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error('非法的前端路径');
  }
  return full;
}
