import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@stackpanel/db';
import { z } from 'zod';
import { normalizePluginDependencies } from '@stackpanel/sdk';
import semver from 'semver';
import {
  assertNoConflictingFrontendPages,
  frontendSummary,
  readFrontendManifest,
} from '../../lib/frontend.ts';
import {
  readFrontendApplyRequest,
  readFrontendApplyStatus,
  requestFrontendApply,
} from '../../lib/frontend-apply.ts';
import { resolvedFrontendSettings, updateFrontendSettings } from '../../lib/frontend-service.ts';
import { settingsErrorToMessage } from '../../lib/frontend-settings.ts';
import {
  BUILTIN_PLUGIN_IDS,
  loadPluginDefinition,
  parsePluginZip,
  pluginPackageDir,
  PluginError,
  removePluginFiles,
  writePluginFiles,
} from '../../lib/plugins.ts';
import { rateLimitConfig } from '../../lib/rate-limit-policy.ts';
import { readSigningPublicKey } from '../../lib/signing-settings.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';
import { publishRuntimeChange } from '../../runtime/coherence.ts';
import type { PluginRuntime } from '../../plugins/runtime.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const patchPluginSchema = z.object({
  enabled: z.boolean(),
});

const pluginIdSchema = z.object({ id: z.string().min(1).max(64) });
const settingsPatchSchema = z.object({
  settings: z.record(
    z.string(),
    z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  ),
});

/** Whether a plugin id is a built-in (immutable via upload). */
function isBuiltin(id: string): boolean {
  return (BUILTIN_PLUGIN_IDS as readonly string[]).includes(id);
}

async function persistDependencyEnabledState(
  prisma: PrismaClient,
  runtime: PluginRuntime,
  id: string,
): Promise<void> {
  const meta = runtime.list().find((plugin) => plugin.id === id);
  for (const dependency of normalizePluginDependencies(meta?.requires ?? [])) {
    const dep = runtime.list().find((plugin) => plugin.id === dependency.id);
    if (!dep) continue;
    await prisma.plugin.upsert({
      where: { id: dependency.id },
      create: {
        id: dependency.id,
        name: dep.name,
        version: dep.version,
        enabled: true,
      },
      update: { name: dep.name, version: dep.version, enabled: true },
    });
  }
}

async function assertFrontendRoutesAvailable(
  runtime: PluginRuntime,
  targetId: string,
): Promise<void> {
  const candidates = runtime
    .list()
    .filter((plugin) => plugin.id === targetId || runtime.isActive(plugin.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const claims = await Promise.all(
    candidates.map(async (plugin) => ({
      id: plugin.id,
      pages: (await readFrontendManifest(pluginPackageDir(plugin.id)))?.pages ?? [],
    })),
  );
  assertNoConflictingFrontendPages(claims);
}

export async function adminPluginRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/plugins',
    {
      preHandler: adminOnly,
      schema: { security: [{ bearerAuth: [] }] },
    },
    async () => {
      const runtime = app.pluginRuntime;
      const prisma = getPrisma();
      const rows = await prisma.plugin.findMany();
      const enabledById = new Map(rows.map((r) => [r.id, r.enabled]));
      const byId = new Map(runtime.list().map((p) => [p.id, p]));
      const plugins = await Promise.all(
        runtime.list().map(async (p) => ({
          id: p.id,
          name: p.name,
          description: p.description ?? null,
          version: p.version,
          state: p.state,
          enabled: enabledById.get(p.id) ?? false,
          source: isBuiltin(p.id) ? 'builtin' : 'dynamic',
          hotReload: true,
          frontend: frontendSummary(await readFrontendManifest(pluginPackageDir(p.id))),
          requires: p.requires,
          dependencies: p.requires.map((dependency) => {
            const installed = byId.get(dependency.id);
            const satisfied =
              Boolean(installed) &&
              (!dependency.range || semver.satisfies(installed?.version ?? '', dependency.range));
            return {
              id: dependency.id,
              range: dependency.range ?? null,
              optional: dependency.optional ?? false,
              installed: Boolean(installed),
              version: installed?.version ?? null,
              satisfied,
            };
          }),
          provides: p.provides,
          consumes: p.consumes,
          consumesStatus: p.consumes.map((consumer) => {
            const target = byId.get(consumer.pluginId);
            const satisfied =
              Boolean(target) &&
              runtime.isActive(consumer.pluginId) &&
              (target?.provides ?? []).includes(consumer.extensionPoint);
            return {
              pluginId: consumer.pluginId,
              extensionPoint: consumer.extensionPoint,
              optional: consumer.optional ?? false,
              satisfied,
            };
          }),
          permissions: p.permissions,
          roleTemplates: p.roleTemplates,
          locales: p.locales,
          signed: existsSync(path.join(pluginPackageDir(p.id), 'signature.json')),
        })),
      );
      return { plugins };
    },
  );

  /** Frontend apply status: whether the web container is rebuilding/restarting. */
  app.get('/admin/plugins/frontend-status', { preHandler: adminOnly }, async () => {
    const [stored, request] = await Promise.all([
      readFrontendApplyStatus(),
      readFrontendApplyRequest(),
    ]);
    // A queued-but-unconsumed request is surfaced as `pending` so the admin UI
    // can show work is in flight (with the right step text) before the web
    // container picks it up. Once the supervisor writes a status carrying the
    // same `requestedAt`, that status wins — the supervisor removes the request
    // file only at the very end, so mere existence of the file is not enough to
    // conclude it is still queued.
    const handled =
      request != null && stored?.requestedAt != null && stored.requestedAt === request.requestedAt;
    const status =
      request && !handled
        ? {
            state: 'pending' as const,
            at: stored?.at ?? new Date().toISOString(),
            requestedAt: request.requestedAt,
            ...(request.label ? { label: request.label } : {}),
            target: request.target,
            action: request.action,
            step: 1,
            steps: request.steps,
          }
        : stored;
    return { status };
  });

  app.post(
    '/admin/plugins/upload',
    {
      preHandler: adminOnly,
      schema: { security: [{ bearerAuth: [] }] },
      ...rateLimitConfig('upload'),
    },
    async (request, reply) => {
      let data: Buffer;
      try {
        const part = await request.file();
        if (!part) return reply.code(400).send({ error: '未上传文件' });
        data = await part.toBuffer();
      } catch {
        return reply.code(413).send({ error: '文件过大或不是有效的 multipart 表单' });
      }
      try {
        const { manifest, files } = parsePluginZip(data, await readSigningPublicKey());
        const runtime = app.pluginRuntime;
        const dependencies = normalizePluginDependencies(manifest.requires);
        const missingDependencies = dependencies.filter(
          (dependency) => !dependency.optional && !runtime.has(dependency.id),
        );
        if (missingDependencies.length > 0) {
          return reply.code(409).send({
            error: `缺少依赖插件：${missingDependencies.map((d) => d.id).join(', ')}`,
          });
        }
        const incompatible = dependencies.find((dependency) => {
          const installed = runtime.list().find((plugin) => plugin.id === dependency.id);
          return (
            !dependency.optional &&
            installed &&
            dependency.range &&
            !semver.satisfies(installed.version, dependency.range)
          );
        });
        if (incompatible) {
          return reply.code(409).send({
            error: `依赖版本不兼容：${incompatible.id} 要求 ${incompatible.range}，当前版本不满足`,
          });
        }
        const prisma = getPrisma();
        const existing = await prisma.plugin.findUnique({ where: { id: manifest.id } });
        const enabled = existing?.enabled ?? true;

        const upgraded = runtime.has(manifest.id);
        const previousDefinition = upgraded ? await loadPluginDefinition(manifest.id) : null;
        const wasActive = upgraded && runtime.isActive(manifest.id);
        const previousHadFrontend = upgraded
          ? Boolean(await readFrontendManifest(pluginPackageDir(manifest.id)))
          : false;
        const fileWrite = await writePluginFiles(manifest.id, files);
        let oldUnregistered = false;
        let newRegistered = false;
        try {
          // Import the candidate while the current runtime remains active. A
          // broken module can then be rolled back without taking routes down.
          const definition = await loadPluginDefinition(manifest.id);
          if (upgraded) {
            await runtime.unregister(manifest.id);
            oldUnregistered = true;
          }
          await runtime.register(definition);
          newRegistered = true;
          if (enabled) {
            await assertFrontendRoutesAvailable(runtime, manifest.id);
            await runtime.activate(manifest.id);
          }
          await prisma.plugin.upsert({
            where: { id: manifest.id },
            create: {
              id: manifest.id,
              name: manifest.name,
              version: manifest.version,
              enabled,
            },
            update: { name: manifest.name, version: manifest.version },
          });
          await fileWrite.commit();
        } catch (err) {
          if (newRegistered) await runtime.unregister(manifest.id);
          await fileWrite.rollback();
          if (oldUnregistered && previousDefinition) {
            await runtime.register(previousDefinition);
            if (wasActive) await runtime.activate(manifest.id);
          }
          throw err;
        }
        await writeAudit({
          action: upgraded ? 'plugin.upgrade' : 'plugin.install',
          resource: 'plugin',
          resourceId: manifest.id,
          meta: { version: manifest.version },
          ...auditContext(request),
        });
        // S8: converge other replicas onto the new definition/state.
        await publishRuntimeChange({ kind: 'plugin', id: manifest.id, action: 'reload' });
        // 有前端产物时，通知 web 容器重建 registry 并重启；否则无需动前端。
        const hasFrontend =
          previousHadFrontend || Boolean(await readFrontendManifest(pluginPackageDir(manifest.id)));
        let frontendApply: { requestedAt: string } | null = null;
        if (hasFrontend) {
          const applyRequest = await requestFrontendApply({
            reason: upgraded ? 'plugin.upgrade' : 'plugin.install',
            requestedBy: request.user?.id ?? null,
            target: 'plugin',
            action: upgraded ? 'update' : 'install',
            label: manifest.name,
            rebuild: true,
          });
          frontendApply = { requestedAt: applyRequest.requestedAt };
        }
        return reply.code(201).send({
          installed: true,
          live: true,
          upgraded,
          id: manifest.id,
          frontendApply,
        });
      } catch (err) {
        if (err instanceof PluginError) {
          return reply.code(err.status).send({ error: err.message });
        }
        request.log.error({ err }, '插件安装失败');
        return reply.code(409).send({ error: '插件安装失败，请检查插件包是否完整有效' });
      }
    },
  );

  app.patch(
    '/admin/plugins/:id',
    {
      preHandler: adminOnly,
      schema: { security: [{ bearerAuth: [] }] },
      ...rateLimitConfig('adminWrite'),
    },
    async (request, reply) => {
      const params = pluginIdSchema.safeParse(request.params);
      const body = patchPluginSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: '请求参数无效' });
      }
      const { id } = params.data;
      const { enabled } = body.data;
      const runtime = app.pluginRuntime;
      const meta = runtime.list().find((p) => p.id === id);
      if (!meta) {
        return reply.code(404).send({ error: '插件不存在' });
      }

      const prisma = getPrisma();
      if (enabled) {
        try {
          await assertFrontendRoutesAvailable(runtime, id);
          await runtime.activate(id);
          await persistDependencyEnabledState(prisma, runtime, id);
        } catch (err) {
          return reply.code(409).send({ error: (err as Error).message });
        }
      } else {
        try {
          await runtime.deactivate(id);
        } catch (err) {
          return reply.code(409).send({ error: (err as Error).message });
        }
      }
      const existing = await prisma.plugin.findUnique({ where: { id } });
      if (existing) {
        await prisma.plugin.update({
          where: { id },
          data: { enabled, name: meta.name, version: meta.version },
        });
      } else {
        try {
          await prisma.plugin.create({
            data: { id, name: meta.name, version: meta.version, enabled },
          });
        } catch {
          await prisma.plugin.update({ where: { id }, data: { enabled } });
        }
      }
      await writeAudit({
        action: enabled ? 'plugin.activate' : 'plugin.deactivate',
        resource: 'plugin',
        resourceId: id,
        ...auditContext(request),
      });
      // S8: converge other replicas without a restart.
      await publishRuntimeChange({
        kind: 'plugin',
        id,
        action: enabled ? 'activate' : 'deactivate',
      });
      // No frontend rebuild here: `/plugins/frontends` filters by active state,
      // so enable/disable takes effect on the next request without a rebuild.
      return { id, enabled };
    },
  );

  app.delete(
    '/admin/plugins/:id',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const params = pluginIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '插件 ID 无效' });
      const { id } = params.data;
      if (isBuiltin(id)) {
        return reply.code(400).send({ error: '内置插件不可删除' });
      }
      const runtime = app.pluginRuntime;
      const hadFrontend = Boolean(await readFrontendManifest(pluginPackageDir(id)));
      const removedName = runtime.list().find((p) => p.id === id)?.name ?? id;
      try {
        await runtime.unregister(id);
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
      await removePluginFiles(id);
      const prisma = getPrisma();
      await prisma.plugin.deleteMany({ where: { id } });
      await writeAudit({
        action: 'plugin.uninstall',
        resource: 'plugin',
        resourceId: id,
        ...auditContext(request),
      });
      // S8: remove the plugin from every replica's runtime.
      await publishRuntimeChange({ kind: 'plugin', id, action: 'remove' });
      if (hadFrontend) {
        await requestFrontendApply({
          reason: 'plugin.uninstall',
          requestedBy: request.user?.id ?? null,
          target: 'plugin',
          action: 'remove',
          label: removedName,
          rebuild: true,
        });
      }
      return reply.code(204).send();
    },
  );

  app.get('/admin/plugins/:id/settings', { preHandler: adminOnly }, async (request, reply) => {
    const params = pluginIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '插件 ID 无效' });
    const { id } = params.data;
    const packageDir = pluginPackageDir(id);
    if (!existsSync(packageDir)) return reply.code(404).send({ error: '插件不存在' });
    const settings = await resolvedFrontendSettings(getPrisma(), 'plugin', id, packageDir);
    return { settings };
  });

  app.patch('/admin/plugins/:id/settings', { preHandler: adminOnly }, async (request, reply) => {
    const params = pluginIdSchema.safeParse(request.params);
    const body = settingsPatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: '请求参数无效' });
    }
    const { id } = params.data;
    const packageDir = pluginPackageDir(id);
    if (!existsSync(packageDir)) return reply.code(404).send({ error: '插件不存在' });
    try {
      const settings = await updateFrontendSettings(
        getPrisma(),
        'plugin',
        id,
        packageDir,
        body.data.settings,
        request.user?.id ?? null,
      );
      await writeAudit({
        action: 'plugin.settings.update',
        resource: 'plugin',
        resourceId: id,
        ...auditContext(request),
      });
      return { settings };
    } catch (err) {
      return reply.code(422).send({ error: settingsErrorToMessage(err) });
    }
  });
}
