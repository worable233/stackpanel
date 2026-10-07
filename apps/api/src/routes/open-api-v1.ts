/**
 * Open platform v1 surface (PLAN-open-platform P1).
 *
 * A thin, versioned veneer over the same domain handlers the web BFF uses —
 * never a second implementation (ADR-0001). Kernel-owned routes are declared
 * here; plugin operations are contributed through `manifest.capabilities` and
 * dispatched by the plugin dispatcher to the plugin's own handler with its own
 * guard (see {@link PluginRuntime} and `/api/v1` in `lib/capability-registry.ts`).
 * The public OpenAPI doc and the discovery endpoint derive from one source.
 *
 * Authentication is the shared kernel path: a session cookie or a platform
 * `ApiToken` (whose scopes ⊆ its owner's permissions), enforced with the
 * standard `requirePermission`.
 *
 * Per-token RPM/concurrency and usage audit are applied once per request outside
 * this module ({@link enforceTokenQuota} for kernel routes below; the dispatcher
 * applies it for plugin aliases; {@link recordTokenUsage} runs from a global
 * `onResponse`), so the two surfaces never diverge.
 *
 * Mutating capabilities require an `Idempotency-Key` and replay through
 * {@link runIdempotent}.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PluginError } from '@stackpanel/sdk';
import { capabilitiesFor } from '../lib/capability-registry.ts';
import { currentUser, requireAuth, requirePermission, requireOpenScope } from '../plugins/auth.ts';
import { getPlatformInfo, setPlatformInfo } from '../lib/platform-info.ts';
import { runIdempotent } from '../lib/idempotency.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { enforceTokenQuota } from '../lib/open-api-guard.ts';
import { UserAdminService } from '../lib/user-admin.ts';
import type { UserAdminActor } from '../lib/user-admin.ts';
import { resolveCommerce, resolveUpstreamServiceSources } from '../lib/commerce.ts';
import { getPrisma } from '../plugins/prisma.ts';

const platformInfoSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(280),
    url: z
      .string()
      .trim()
      .max(2048)
      .nullable()
      .transform((value) => value || null)
      .refine(
        (value) => value === null || /^https?:\/\//.test(value),
        'Platform URL must use HTTP or HTTPS',
      ),
  })
  .strict();

const ledgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Identity + permission + per-token quota, in that order. */
const guarded = (...permissions: string[]) => [
  requireAuth,
  ...permissions.map((permission) => requirePermission(permission)),
  enforceTokenQuota,
];

/**
 * Identity + refined `资源:read|write` scope + per-token quota. The refined
 * scope is the admission gate for token callers; a coarse permission alone does
 * not grant a refined read/write operation (P1 slice four).
 */
const scoped = (scope: string) => [requireAuth, requireOpenScope(scope), enforceTokenQuota];

const userListQuerySchema = z.object({
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
  groupIds: z.array(z.string().min(1)).optional(),
});

const updateUserSchema = z
  .object({
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    groupIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((v) => v.status !== undefined || v.groupIds !== undefined, {
    message: '至少需要修改状态或权限组',
  });

const resetPasswordSchema = z.object({ password: z.string().min(8).optional() });

const walletAdjustSchema = z.object({
  amount: z
    .number()
    .int()
    .refine((v) => v !== 0, '金额不能为 0'),
  note: z.string().trim().max(191).default('管理员调整'),
});

const giftServiceSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(1).max(20).default(1),
  expiresAt: z.string().datetime().nullish(),
});

const idParamSchema = z.object({ id: z.string().min(1) });

export async function openApiV1Routes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/platform', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return { platform: await getPlatformInfo() };
  });

  app.patch(
    '/api/v1/platform',
    { preHandler: guarded('platform.admin') },
    async (request, reply) => {
      const body = platformInfoSchema.safeParse(request.body);
      if (!body.success) {
        throw new PluginError('validation.invalid', 422, '请求参数无效');
      }
      return runIdempotent(request, reply, async () => {
        const platform = await setPlatformInfo(body.data, request.user?.id ?? null);
        await writeAudit({
          action: 'platform.info.update',
          resource: 'platform',
          meta: {
            name: platform.name,
            url: platform.url,
            surface: 'api/v1',
            via: request.user?.viaApiToken ? 'api_token' : 'session',
          },
          ...auditContext(request),
        });
        return { platform };
      });
    },
  );

  app.get('/api/v1/me', { preHandler: guarded() }, async (request) => {
    const user = currentUser(request);
    return {
      user: { id: user.id, email: user.email, status: user.status },
      viaApiToken: user.viaApiToken ?? false,
      scopes: [...(user.tokenScopes ?? [])].sort(),
      effectivePermissions: [...user.permissions].sort(),
      ...(user.viaApiToken ? { effectiveScopes: [...(user.effectiveScopes ?? [])].sort() } : {}),
    };
  });

  app.get('/api/v1/capabilities', { preHandler: guarded() }, async (request) => {
    const user = currentUser(request);
    return {
      capabilities: capabilitiesFor(
        user.permissions,
        request.server.pluginRuntime.listCapabilities(),
        user.effectiveScopes,
      ),
    };
  });

  app.get('/api/v1/wallet/balance', { preHandler: guarded() }, async (request) => {
    const account = await request.server.wallet.getAccount(currentUser(request).id);
    if (!account) {
      throw new PluginError('wallet.account.not_found', 404, 'Wallet account does not exist');
    }
    return { account };
  });

  app.get('/api/v1/wallet/ledger', { preHandler: guarded() }, async (request) => {
    const query = ledgerQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new PluginError('validation.invalid', 422, '请求参数无效');
    }
    const entries = await request.server.wallet.listLedger(
      currentUser(request).id,
      query.data.limit,
    );
    return { entries };
  });

  app.get('/api/v1/wallet/accounts', { preHandler: guarded('platform.admin') }, async (request, reply) => {
    const query = ledgerQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new PluginError('validation.invalid', 422, '请求参数无效');
    }
    const accounts = await request.server.wallet.listAccounts(query.data.limit);
    reply.header('Cache-Control', 'no-store');
    return { accounts };
  });

  // --- Users (P1 slice four): same kernel service as /admin/users ----------
  const userAdmin = (request: Parameters<typeof currentUser>[0]): UserAdminService =>
    new UserAdminService({
      prisma: getPrisma(),
      wallet: request.server.wallet,
      auth: request.server.auth,
      commerce: resolveCommerce(request.server.pluginRuntime),
      upstreamServiceSources: resolveUpstreamServiceSources(request.server.pluginRuntime),
    });

  /** The acting principal; `platform.admin` gates escalation (audit H-1). */
  const actorOf = (request: Parameters<typeof currentUser>[0]): UserAdminActor => ({
    id: request.user?.id,
    permissions: request.user?.permissions ?? new Set(),
  });

  app.get('/api/v1/users', { preHandler: scoped('user:read') }, async (request) => {
    const query = userListQuerySchema.safeParse(request.query);
    if (!query.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
    return userAdmin(request).listUsers(query.data);
  });

  app.get('/api/v1/users/:id', { preHandler: scoped('user:read') }, async (request) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
    return userAdmin(request).getUserDetail(params.data.id);
  });

  app.post('/api/v1/users', { preHandler: scoped('user:write') }, async (request, reply) => {
    const body = createUserSchema.safeParse(request.body);
    if (!body.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
    return runIdempotent(request, reply, async () => {
      reply.code(201);
      return userAdmin(request).createUser(body.data, auditContext(request), actorOf(request));
    });
  });

  app.patch('/api/v1/users/:id', { preHandler: scoped('user:write') }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const body = updateUserSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      throw new PluginError('validation.invalid', 422, '请求参数无效');
    }
    return runIdempotent(request, reply, async () =>
      userAdmin(request).updateUser(
        params.data.id,
        body.data,
        actorOf(request),
        auditContext(request),
      ),
    );
  });

  app.post(
    '/api/v1/users/:id/reset-password',
    { preHandler: scoped('user:write') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const body = resetPasswordSchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        throw new PluginError('validation.invalid', 422, '请求参数无效');
      }
      return runIdempotent(request, reply, async () =>
        userAdmin(request).resetPassword(
          params.data.id,
          body.data.password,
          auditContext(request),
          actorOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/users/:id/wallet',
    { preHandler: scoped('user:write') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const body = walletAdjustSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        throw new PluginError('validation.invalid', 422, '请求参数无效');
      }
      return runIdempotent(request, reply, async () =>
        userAdmin(request).adjustWallet(
          params.data.id,
          body.data.amount,
          body.data.note,
          request.user?.id,
        ),
      );
    },
  );

  app.post(
    '/api/v1/users/:id/services',
    { preHandler: scoped('user:write') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const body = giftServiceSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        throw new PluginError('validation.invalid', 422, '请求参数无效');
      }
      return runIdempotent(request, reply, async () =>
        userAdmin(request).giftService(params.data.id, body.data, auditContext(request)),
      );
    },
  );
}
