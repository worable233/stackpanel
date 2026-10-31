import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FrontendManifest } from '@stackpanel/sdk';
import {
  frontendDescriptor,
  resolvedFrontendSettings,
  serveFrontendFile,
  serveRevisionFile,
  settingsSchemaDescriptor,
} from '../lib/frontend-service.ts';
import { readFrontendManifest } from '../lib/frontend.ts';
import { ensureRuntimeAdminBundle } from '../lib/frontend-runtime-bundle.ts';
import { pluginPackageDir } from '../lib/plugins.ts';
import {
  isRevisionName,
  readCurrentRevision,
  ensureCurrentRevision,
  isRevisionComplete,
} from '../lib/frontend-revisions.ts';
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
    const frontends: Array<{
      id: string;
      manifest: FrontendManifest;
      builtin: boolean;
      execution: 'trusted' | 'isolated';
      serverExecution: 'allowed' | 'declarative';
      revision?: string;
    }> = [];
    for (const plugin of app.pluginRuntime.list()) {
      if (plugin.state !== 'active') continue;
      const packageDir = pluginPackageDir(plugin.id);
      // 兼容旧的 admin 前端产物：早于运行期装载的安装只有 `dist/admin.js`，缺少
      // 浏览器可装载的 `dist/admin.runtime.js`，会让 web 侧的动态 import 404。
      // 必须在读取 manifest 与计算 revision **之前**补齐，这样派生的产物既进入
      // `files[]` 白名单，也进入 revision 摘要。幂等且失败不影响其余字段。
      const repaired = await ensureRuntimeAdminBundle(packageDir).catch(() => false);
      const manifest = await readFrontendManifest(packageDir);
      if (!manifest) continue;
      // Admission decision for server-side execution in the web process
      // (contract 03 §3.1). The runtime already resolved this to the concrete
      // grant (`builtin` OR operator allowlist ⇒ `server`), so the web layer
      // reads one field instead of re-deriving trust from provenance.
      const serverExecution =
        plugin.frontendExecutions === 'server'
          ? ('allowed' as const)
          : ('declarative' as const);
      const pointer = await readCurrentRevision(packageDir);
      const current =
        pointer && !repaired && (await isRevisionComplete(packageDir, pointer.revision))
          ? pointer
          : await ensureCurrentRevision(packageDir).catch(() => null);
      frontends.push({
        id: plugin.id,
        manifest,
        builtin: plugin.builtin,
        execution: plugin.execution,
        serverExecution,
        ...(current ? { revision: current.revision } : {}),
      });
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
   * Expose the active plugin's route table to the web BFF.
   *
   * The same-origin BFF proxy uses this to validate **both** dynamic GET routes
   * (finders) and mutation routes before forwarding, so it intentionally lists
   * every method — not just mutations. The action executor matches its declared
   * POST/PATCH/DELETE against this table. This also lets the host reject a
   * frontend action that tries to target a kernel route or a different plugin
   * before it can use the current session.
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

  /**
   * The subset of an active plugin's route table that an **anonymous** browser
   * may call.
   *
   * The same-origin BFF (`apps/web/src/app/api/plugins/[...path]`) forwards a
   * browser request only after resolving the plugin namespace against this
   * kernel-owned table, and `/action-targets` deliberately requires a session
   * because it also lists everything the caller may *not* use. That leaves one
   * case unserved: a widget that bootstraps before login — a captcha challenge,
   * a price preview — has to reach a route the plugin declared public, and the
   * browser has no session yet.
   *
   * This lists exactly those routes (`auth: 'public'`, no `permission`), which
   * is metadata an anonymous caller can discover by simply calling them. The
   * dispatcher still re-checks `auth` on the forwarded request, so this table is
   * not the admission decision — it only stops the BFF from becoming a generic
   * same-origin proxy.
   */
  app.get(
    '/plugins/:id/public-routes',
    { ...rateLimitConfig('publicRead') },
    async (request, reply) => {
      const params = pluginIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '插件 ID 无效' });
      const { id } = params.data;
      if (!app.pluginRuntime.isActive(id)) {
        return reply.code(404).send({ error: '插件不存在' });
      }
      const routes = app.pluginDispatcher
        .list()
        .filter((route) => route.pluginId === id && route.auth === 'public' && !route.permission)
        .map((route) => ({ method: route.method, path: route.path }));
      return { routes };
    },
  );

  app.get(
    '/plugins/:id/frontend/*',
    { ...rateLimitConfig('publicRead') },
    async (request, reply) => {
      const params = pluginIdSchema.safeParse(request.params);
      const asset = (request.params as { '*': string })['*'];
      if (!params.success || !asset) return reply.code(400).send({ error: '请求参数无效' });
      const { id } = params.data;
      if (!app.pluginRuntime.isActive(id) || !existsSync(pluginPackageDir(id))) {
        return reply.code(404).send({ error: '插件不存在' });
      }
      // Contract 04 §2: `<revision>/<asset...>` serves from the immutable
      // revision store; a legacy `<asset...>` (starting with `dist/`) serves
      // from the flat frontend. The revision segment is a hex digest, so the
      // two shapes are unambiguous and share one route.
      const packageDir = pluginPackageDir(id);
      const [head, ...tail] = asset.split('/');
      if (head && isRevisionName(head) && tail.length > 0) {
        return serveRevisionFile(reply, packageDir, head, tail.join('/'), {
          kind: 'plugins',
          id,
        });
      }
      if (asset.includes('..') || asset.includes('\\')) {
        return reply.code(400).send({ error: '非法的前端路径' });
      }
      return serveFrontendFile(reply, packageDir, asset);
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
