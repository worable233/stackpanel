/**
 * Extension 引擎的通用 REST 面（PLAN-E1 S5）。
 *
 * `/custom/:ns/:name` 是插件模型对前端的既有契约（消费者只有集成测试与既有
 * 前端）。路由只装一次，按 kind 在请求期解析；激活 / 停用插件不重连路由。
 *
 * 与旧 `CustomModelRegistry.install` 的对外行为保持一致：相同的路径、权限点、
 * 分页上限与响应体（`{ id, kind, data, ownerId, createdAt, updatedAt }`）。
 * 差异在内部：数据读写经 `ctx.extensions` 能力化客户端，`scoped` 模型的越权
 * 访问收敛为 404。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PluginError, customModelPermissions } from '@stackpanel/sdk';
import type {
  CustomModelDefinition,
  ExtensionCreateOptions,
  ExtensionInstance,
  ExtensionQuery,
} from '@stackpanel/sdk';
import { requireAuth, requireRole } from '../plugins/auth.ts';
import type { RegisteredModel } from './registry.ts';
import type { ExtensionService } from './service.ts';

const MAX_PAGE_SIZE = 100;

const listQuerySchema = z.object({
  ownerId: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
});

const idParamSchema = z.object({
  kind: z.string().min(1).max(128),
  id: z.string().min(1).max(128),
});

/** Parse a `/custom/:ns/:name` path into a `ns/name` kind. */
const kindParamsSchema = z.object({
  ns: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/),
});

function kindFromParams(params: { ns: string; name: string }): string {
  return `${params.ns}/${params.name}`;
}

const createBodySchema = z.object({
  data: z.record(z.string(), z.unknown()),
  ownerId: z.string().optional(),
});

const updateBodySchema = z.object({
  data: z.record(z.string(), z.unknown()),
});

/** Map an engine instance onto the legacy `/custom` response shape. */
function toResponse(instance: ExtensionInstance<unknown>, kind: string) {
  return {
    id: instance.name,
    kind,
    data: instance.spec as Record<string, unknown>,
    ownerId: instance.ownerId,
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
  };
}

export function installExtensionRoutes(app: FastifyInstance, service: ExtensionService): void {
  const userOrAdmin = [requireAuth];
  const adminOnly = [requireAuth, requireRole('ADMIN')];

  const canRead = (
    request: { user?: { permissions: Set<string> } },
    definition: CustomModelDefinition,
  ): boolean => {
    const permission = definition.readPermission ?? customModelPermissions(definition.kind).read;
    return request.user?.permissions.has(permission) ?? false;
  };

  const canWrite = (
    request: { user?: { permissions: Set<string> } },
    definition: CustomModelDefinition,
  ): boolean => {
    const permission = definition.permission ?? customModelPermissions(definition.kind).write;
    return request.user?.permissions.has(permission) ?? false;
  };

  const requireModel = (kind: string): RegisteredModel => {
    const registered = service.byKind(kind);
    if (!registered) {
      throw new PluginError('custom.unknown_model', 404, `未知的自定义模型：${kind}`);
    }
    return registered;
  };

  app.get('/custom/:ns/:name', { preHandler: userOrAdmin }, async (request) => {
    const params = kindParamsSchema.safeParse(request.params);
    if (!params.success) throw new PluginError('request.invalid', 400, 'kind 无效');
    const kind = kindFromParams(params.data);
    const registered = requireModel(kind);
    if (!canRead(request, registered.definition)) {
      throw new PluginError('auth.forbidden', 403, '没有读取权限');
    }
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) throw new PluginError('request.invalid', 400, '查询参数无效');
    const { page, pageSize } = query.data;

    const client = service.client(registered.pluginId, request.user?.id ?? null);
    const listQuery: ExtensionQuery = {
      orderBy: { field: 'createdAt', desc: true },
      page,
      pageSize,
    };
    if (!registered.definition.scoped && query.data.ownerId) {
      listQuery.where = { ownerId: { eq: query.data.ownerId } };
    }
    const result = await client.list<Record<string, unknown>>(registered.definition, listQuery);
    return {
      items: result.items.map((instance) => toResponse(instance, kind)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  });

  app.post('/custom/:ns/:name', { preHandler: userOrAdmin }, async (request, reply) => {
    const params = kindParamsSchema.safeParse(request.params);
    if (!params.success) throw new PluginError('request.invalid', 400, 'kind 无效');
    const kind = kindFromParams(params.data);
    const registered = requireModel(kind);
    if (!canWrite(request, registered.definition)) {
      throw new PluginError('auth.forbidden', 403, '没有写入权限');
    }
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) throw new PluginError('request.invalid', 400, '请求体无效');

    const client = service.client(registered.pluginId, request.user?.id ?? null);
    const options: ExtensionCreateOptions = {};
    if (registered.definition.scoped || body.data.ownerId) {
      options.ownerId = body.data.ownerId ?? request.user?.id ?? null;
    }
    const instance = await client.create<Record<string, unknown>>(
      registered.definition,
      body.data.data,
      options,
    );
    return reply.code(201).send(toResponse(instance, kind));
  });

  app.get('/custom/:ns/:name/:id', { preHandler: userOrAdmin }, async (request, reply) => {
    const routeParams = request.params as { ns?: string; name?: string; id?: string };
    const params = idParamSchema.safeParse({
      id: routeParams.id ?? '',
      kind: kindFromParams({ ns: routeParams.ns ?? '', name: routeParams.name ?? '' }),
    });
    if (!params.success) throw new PluginError('request.invalid', 400, '参数无效');
    const { kind, id } = params.data;
    const registered = requireModel(kind);
    if (!canRead(request, registered.definition)) {
      throw new PluginError('auth.forbidden', 403, '没有读取权限');
    }
    const client = service.client(registered.pluginId, request.user?.id ?? null);
    const instance = await client.get<Record<string, unknown>>(registered.definition, id);
    if (!instance) return reply.code(404).send({ error: '实例不存在' });
    return toResponse(instance, kind);
  });

  app.patch('/custom/:ns/:name/:id', { preHandler: userOrAdmin }, async (request) => {
    const routeParams = request.params as { ns?: string; name?: string; id?: string };
    const params = idParamSchema.safeParse({
      id: routeParams.id ?? '',
      kind: kindFromParams({ ns: routeParams.ns ?? '', name: routeParams.name ?? '' }),
    });
    if (!params.success) throw new PluginError('request.invalid', 400, '参数无效');
    const { kind, id } = params.data;
    const registered = requireModel(kind);
    if (!canWrite(request, registered.definition)) {
      throw new PluginError('auth.forbidden', 403, '没有写入权限');
    }
    const body = updateBodySchema.safeParse(request.body);
    if (!body.success) throw new PluginError('request.invalid', 400, '请求体无效');
    const client = service.client(registered.pluginId, request.user?.id ?? null);
    const instance = await client.update<Record<string, unknown>>(
      registered.definition,
      id,
      body.data.data,
    );
    return toResponse(instance, kind);
  });

  app.delete('/custom/:ns/:name/:id', { preHandler: userOrAdmin }, async (request, reply) => {
    const routeParams = request.params as { ns?: string; name?: string; id?: string };
    const params = idParamSchema.safeParse({
      id: routeParams.id ?? '',
      kind: kindFromParams({ ns: routeParams.ns ?? '', name: routeParams.name ?? '' }),
    });
    if (!params.success) throw new PluginError('request.invalid', 400, '参数无效');
    const { kind, id } = params.data;
    const registered = requireModel(kind);
    if (!canWrite(request, registered.definition)) {
      throw new PluginError('auth.forbidden', 403, '没有写入权限');
    }
    const client = service.client(registered.pluginId, request.user?.id ?? null);
    await client.delete(registered.definition, id);
    return reply.code(204).send();
  });

  // Admin: list declared models with their metadata.
  app.get('/admin/custom/models', { preHandler: adminOnly }, async () => {
    return {
      models: service.list().map(({ definition }) => ({
        kind: definition.kind,
        label: definition.label,
        scoped: definition.scoped ?? false,
        permission: customModelPermissions(definition.kind),
        indexes: definition.indexes ?? [],
        finalizers: definition.finalizers ?? [],
        retention: definition.retention ?? 'delete',
      })),
    };
  });
}
