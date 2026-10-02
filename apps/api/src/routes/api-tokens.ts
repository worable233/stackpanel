import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { apiTokenPrefix, generateApiToken, toStringArray } from '../lib/api-tokens.ts';
import { canGrantScope, grantableScopesFor } from '../lib/capability-registry.ts';
import { rateLimitConfig } from '../lib/rate-limit-policy.ts';
import { isKnownPlatformScope, mcpGrantableScopes } from '../mcp/index.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { permissionsOf, currentUser, requireAuth, requireRole } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';

/**
 * Platform API token self-service (`/me/api-tokens`) plus an admin oversight
 * surface (`/admin/api-tokens`). Tokens are the kernel credential used by the
 * open API, MCP and the model gateway; effective permissions are always the
 * intersection of the token scopes and the owner's current permissions.
 */

const adminOnly = [requireAuth, requireRole('ADMIN')];

const ipEntry = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[0-9a-fA-F.:]+(\/\d{1,3})?$/, 'IP 或 CIDR 格式无效');

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    scopes: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
    ipAllowlist: z.array(ipEntry).max(50).default([]),
    expiresAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .transform((value) => (value ? new Date(value) : null)),
  })
  .strict();

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    scopes: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
    ipAllowlist: z.array(ipEntry).max(50).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    expiresAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .transform((value) => (value === undefined ? undefined : value ? new Date(value) : null)),
  })
  .strict();

const idParamSchema = z.object({ id: z.string().min(1).max(191) });

type TokenRow = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: unknown;
  ipAllowlist: unknown;
  status: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  createdAt: Date;
};

function toView(row: TokenRow) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: toStringArray(row.scopes),
    ipAllowlist: toStringArray(row.ipAllowlist),
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    lastUsedIp: row.lastUsedIp,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Scopes a caller may hand to a token: their grants, refined resources they govern,
 * plus identity-level delegable platform scopes (mcp.write).
 */
async function grantableScopes(request: FastifyRequest): Promise<string[]> {
  const owned = request.user?.permissions ?? new Set<string>();
  const scopes = new Set(grantableScopesFor(owned));
  for (const scope of mcpGrantableScopes()) scopes.add(scope.key);
  return [...scopes].sort();
}

/**
 * Scopes a caller may not grant: refined `资源:read|write` scopes whose coarse gate the
 * owner lacks, except identity-level delegable platform scopes (always grantable).
 */
function illegalScopes(scopes: readonly string[], owned: ReadonlySet<string>): string[] {
  return scopes.filter((scope) => !isKnownPlatformScope(scope) && !canGrantScope(scope, owned));
}

export async function apiTokenRoutes(app: FastifyInstance): Promise<void> {
  const db = getPrisma();

  /** Scopes the caller is allowed to grant, with display names. */
  app.get(
    '/me/api-tokens/scopes',
    { preHandler: requireAuth },
    async (request) => {
      const keys = await grantableScopes(request);
      const rows = keys.length
        ? await db.permission.findMany({ where: { key: { in: keys } }, select: { key: true, name: true } })
        : [];
      const names = new Map(rows.map((row) => [row.key, row.name]));
      for (const scope of mcpGrantableScopes()) names.set(scope.key, scope.name);
      return {
        prefix: apiTokenPrefix(),
        scopes: keys.map((key) => ({ key, name: names.get(key) ?? key })),
      };
    },
  );

  app.get('/me/api-tokens', { preHandler: requireAuth }, async (request) => {
    const rows = await db.apiToken.findMany({
      where: { userId: currentUser(request).id },
      orderBy: { createdAt: 'desc' },
    });
    return { tokens: rows.map(toView) };
  });

  app.post(
    '/me/api-tokens',
    { preHandler: requireAuth, ...rateLimitConfig('credentialWrite') },
    async (request, reply) => {
      const body = createSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: '参数无效' });
      const owned = await permissionsOf(currentUser(request).id);
      const illegal = illegalScopes(body.data.scopes, owned);
      if (illegal.length > 0) {
        return reply.code(403).send({ error: `无权授予以下权限：${illegal.join('、')}` });
      }
      const generated = generateApiToken();
      const row = await db.apiToken.create({
        data: {
          userId: currentUser(request).id,
          name: body.data.name,
          keyPrefix: generated.keyPrefix,
          keyHash: generated.keyHash,
          scopes: body.data.scopes,
          ipAllowlist: body.data.ipAllowlist,
          expiresAt: body.data.expiresAt ?? null,
        },
      });
      await writeAudit({
        action: 'api_token.create',
        resource: 'api_token',
        resourceId: row.id,
        meta: { name: row.name, scopes: body.data.scopes },
        ...auditContext(request),
      });
      // 明文只在这一次返回；此后库里只剩哈希。
      return { token: generated.plaintext, apiToken: toView(row) };
    },
  );

  app.patch(
    '/me/api-tokens/:id',
    { preHandler: requireAuth, ...rateLimitConfig('credentialWrite') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '参数无效' });
      const body = patchSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: '参数无效' });
      const existing = await db.apiToken.findUnique({ where: { id: params.data.id } });
      if (!existing || existing.userId !== currentUser(request).id) {
        return reply.code(404).send({ error: 'API 密钥不存在' });
      }
      if (body.data.scopes) {
        const owned = await permissionsOf(currentUser(request).id);
        const illegal = illegalScopes(body.data.scopes, owned);
        if (illegal.length > 0) {
          return reply.code(403).send({ error: `无权授予以下权限：${illegal.join('、')}` });
        }
      }
      const row = await db.apiToken.update({
        where: { id: existing.id },
        data: {
          ...(body.data.name !== undefined ? { name: body.data.name } : {}),
          ...(body.data.scopes !== undefined ? { scopes: body.data.scopes } : {}),
          ...(body.data.ipAllowlist !== undefined ? { ipAllowlist: body.data.ipAllowlist } : {}),
          ...(body.data.status !== undefined ? { status: body.data.status } : {}),
          ...(body.data.expiresAt !== undefined ? { expiresAt: body.data.expiresAt } : {}),
        },
      });
      await writeAudit({
        action: 'api_token.update',
        resource: 'api_token',
        resourceId: row.id,
        meta: { fields: Object.keys(body.data) },
        ...auditContext(request),
      });
      return { apiToken: toView(row) };
    },
  );

  app.delete(
    '/me/api-tokens/:id',
    { preHandler: requireAuth, ...rateLimitConfig('credentialWrite') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '参数无效' });
      const existing = await db.apiToken.findUnique({ where: { id: params.data.id } });
      if (!existing || existing.userId !== currentUser(request).id) {
        return reply.code(404).send({ error: 'API 密钥不存在' });
      }
      await db.apiToken.delete({ where: { id: existing.id } });
      await writeAudit({
        action: 'api_token.revoke',
        resource: 'api_token',
        resourceId: existing.id,
        meta: { name: existing.name },
        ...auditContext(request),
      });
      return { ok: true };
    },
  );

  /** Per-token usage audit: the caller's own key. */
  app.get('/me/api-tokens/:id/usage', { preHandler: requireAuth }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '参数无效' });
    const existing = await db.apiToken.findUnique({ where: { id: params.data.id } });
    const callerId = request.user?.id;
    if (!existing || existing.userId !== callerId) {
      return reply.code(404).send({ error: 'API 密钥不存在' });
    }
    return tokenUsage(db, existing.id);
  });

  // --- Admin oversight -----------------------------------------------------

  app.get('/admin/api-tokens', { preHandler: adminOnly }, async (request, reply) => {
    const query = z
      .object({ userId: z.string().trim().max(191).optional() })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '查询参数无效' });
    const rows = await db.apiToken.findMany({
      ...(query.data.userId ? { where: { userId: query.data.userId } } : {}),
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { user: { select: { email: true } } },
    });
    return {
      tokens: rows.map((row) => ({ ...toView(row), userEmail: row.user.email })),
    };
  });

  app.delete('/admin/api-tokens/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '参数无效' });
    const existing = await db.apiToken.findUnique({ where: { id: params.data.id } });
    if (!existing) return reply.code(404).send({ error: 'API 密钥不存在' });
    await db.apiToken.delete({ where: { id: existing.id } });
    await writeAudit({
      action: 'api_token.admin_revoke',
      resource: 'api_token',
      resourceId: existing.id,
      meta: { name: existing.name, userId: existing.userId },
      ...auditContext(request),
    });
    return { ok: true };
  });

  /** Admin oversight: recent usage for any token. */
  app.get('/admin/api-tokens/:id/usage', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '参数无效' });
    const existing = await db.apiToken.findUnique({ where: { id: params.data.id } });
    if (!existing) return reply.code(404).send({ error: 'API 密钥不存在' });
    return tokenUsage(db, existing.id);
  });
}

/** Recent audit rows for one token, newest first. */
async function tokenUsage(db: ReturnType<typeof getPrisma>, apiTokenId: string) {
  const rows = await db.apiTokenUsage.findMany({
    where: { apiTokenId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return {
    usage: rows.map((row) => ({
      id: row.id,
      method: row.method,
      path: row.path,
      capabilityId: row.capabilityId,
      statusCode: row.statusCode,
      durationMs: row.durationMs,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
