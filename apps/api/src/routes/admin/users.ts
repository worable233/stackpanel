import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { userListResponseSchema, userResponseSchema } from '../../lib/openapi.ts';
import { UserAdminService } from '../../lib/user-admin.ts';
import type { UserAdminActor } from '../../lib/user-admin.ts';
import { resolveCommerce, resolveUpstreamServiceSources } from '../../lib/commerce.ts';
import { auditContext } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';

const createUserResponseSchema = {
  type: 'object',
  required: ['user'],
  properties: {
    user: userResponseSchema,
    generatedPassword: { type: 'string' },
  },
} as const;

/**
 * Admin user BFF. Every handler delegates to the shared {@link UserAdminService}
 * so the open `/api/v1/users*` surface shares one implementation (ADR-0001).
 */
const adminOnly = [requireAuth, requireRole('ADMIN')];

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(64).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  groupId: z.string().min(1).optional(),
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).default('ACTIVE'),
  /** Permission group ids to assign (defaults to the `user` group). */
  groupIds: z.array(z.string().min(1)).optional(),
});

const updateUserSchema = z
  .object({
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    /** Replace the user's group memberships (additive roles). */
    groupIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((v) => v.status !== undefined || v.groupIds !== undefined, {
    message: '至少需要修改状态或权限组',
  });

const resetPasswordSchema = z.object({
  password: z.string().min(8).optional(),
});

const idParamSchema = z.object({ id: z.string().min(1) });
const serviceParamSchema = z.object({ id: z.string().min(1), serviceId: z.string().min(1) });

function service(request: FastifyRequest): UserAdminService {
  return new UserAdminService({
    prisma: getPrisma(),
    wallet: request.server.wallet,
    auth: request.server.auth,
    commerce: resolveCommerce(request.server.pluginRuntime),
    upstreamServiceSources: resolveUpstreamServiceSources(request.server.pluginRuntime),
  });
}

/** The acting principal, derived from the authenticated request. */
function actorOf(request: FastifyRequest): UserAdminActor {
  return { id: request.user?.id, permissions: request.user?.permissions ?? new Set() };
}

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/users',
    {
      preHandler: adminOnly,
      schema: {
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            pageSize: { type: 'number' },
            q: { type: 'string' },
            status: { type: 'string' },
            groupId: { type: 'string' },
          },
        },
        response: {
          200: userListResponseSchema,
          400: { type: 'object', properties: { error: { type: 'string' } } },
          401: { type: 'object', properties: { error: { type: 'string' } } },
          403: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: '查询参数无效' });
      }
      return service(request).listUsers(query.data);
    },
  );

  app.post(
    '/admin/users',
    {
      preHandler: adminOnly,
      schema: {
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string' },
            password: { type: 'string' },
            status: { type: 'string' },
            groupIds: { type: 'array', items: { type: 'string' } },
          },
        },
        response: {
          201: createUserResponseSchema,
          400: { type: 'object', properties: { error: { type: 'string' } } },
          409: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const body = createUserSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: '请求参数无效' });
      }
      const result = await service(request).createUser(
        body.data,
        auditContext(request),
        actorOf(request),
      );
      return reply.code(201).send(result);
    },
  );

  app.patch('/admin/users/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const body = updateUserSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: '请求参数无效' });
    }
    return service(request).updateUser(
      params.data.id,
      body.data,
      actorOf(request),
      auditContext(request),
    );
  });

  app.post('/admin/users/:id/reset-password', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const body = resetPasswordSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: '请求参数无效' });
    }
    return service(request).resetPassword(
      params.data.id,
      body.data.password,
      auditContext(request),
      actorOf(request),
    );
  });

  app.get('/admin/users/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
    return service(request).getUserDetail(params.data.id);
  });

  app.post('/admin/users/:id/wallet', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const body = z
      .object({
        amount: z
          .number()
          .int()
          .refine((v) => v !== 0, '金额不能为 0'),
        note: z.string().trim().max(191).default('管理员调整'),
      })
      .safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: '请求参数无效' });
    return service(request).adjustWallet(
      params.data.id,
      body.data.amount,
      body.data.note,
      request.user?.id,
    );
  });

  app.post('/admin/users/:id/impersonate', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
    return service(request).impersonate(params.data.id, auditContext(request), actorOf(request));
  });

  app.get('/admin/users/:id/services', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
    return service(request).listServices(params.data.id);
  });

  app.post('/admin/users/:id/services', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const body = z
      .object({
        productId: z.string().min(1),
        quantity: z.number().int().min(1).max(20).default(1),
        expiresAt: z.string().datetime().nullish(),
      })
      .safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: '请求参数无效' });
    const result = await service(request).giftService(
      params.data.id,
      body.data,
      auditContext(request),
    );
    return reply.code(201).send(result);
  });

  app.patch(
    '/admin/users/:id/services/:serviceId',
    { preHandler: adminOnly },
    async (request, reply) => {
      const params = serviceParamSchema.safeParse(request.params);
      const body = z
        .object({
          expiresAt: z.string().datetime().nullable().optional(),
          status: z
            .enum([
              'PENDING_PROVISION',
              'PROVISIONING',
              'ACTIVE',
              'SUSPENDED',
              'TERMINATED',
              'FAILED',
            ])
            .optional(),
        })
        .refine((v) => v.expiresAt !== undefined || v.status !== undefined, {
          message: '至少需要修改一个字段',
        })
        .safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: '请求参数无效' });
      return service(request).updateService(
        params.data.id,
        params.data.serviceId,
        body.data,
        auditContext(request),
      );
    },
  );

  app.delete(
    '/admin/users/:id/services/:serviceId',
    { preHandler: adminOnly },
    async (request, reply) => {
      const params = serviceParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
      await service(request).deleteService(
        params.data.id,
        params.data.serviceId,
        auditContext(request),
      );
      return reply.code(204).send();
    },
  );

  // --- Upstream already-purchased services: bind / unbind ------------------

  app.get(
    '/admin/users/:id/upstream-services',
    { preHandler: adminOnly },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
      return service(request).listUpstreamServices(params.data.id);
    },
  );

  app.post(
    '/admin/users/:id/upstream-services',
    { preHandler: adminOnly },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const body = z
        .object({
          sourceId: z.string().min(1),
          providerServiceId: z.string().min(1),
        })
        .safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: '请求参数无效' });
      const result = await service(request).bindUpstreamService(
        params.data.id,
        body.data,
        auditContext(request),
      );
      return reply.code(201).send(result);
    },
  );

  app.delete(
    '/admin/users/:id/upstream-services/:serviceId',
    { preHandler: adminOnly },
    async (request, reply) => {
      const params = serviceParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
      await service(request).unbindUpstreamService(
        params.data.id,
        params.data.serviceId,
        auditContext(request),
      );
      return reply.code(204).send();
    },
  );
}
