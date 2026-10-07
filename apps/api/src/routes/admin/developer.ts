/**
 * 开发者控制台（开放平台 P4 / DEV-CONSOLE；写端点 CONSOLE-WRITE）。
 *
 * 分发侧三个横切面：
 *   - 渠道伙伴（`resellers`）：SP v1 入站身份的密钥、scope、限额与最近使用；
 *   - webhook 投递（`webhook_deliveries`）：出站回调的 at-least-once 投递状态；
 *   - 调用审计（`audit_logs` 中 `sp_v1.call`）：伙伴对 `/sp/v1/*` 的调用轨迹。
 *
 * 这些是**内核归属**的运行态数据，控制台投影运行态并管理渠道生命周期：新建渠道
 * （服务端生成 Ed25519 入站密钥，私钥仅一次性返回）、更新、轮换密钥、删除。全部写
 * 操作落审计。私钥永不出圈：`webhookPrivateKey` 只以布尔 `hasWebhookKey` 形式暴露，
 * 入站私钥先于存储返回给操作者后不再可读。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isPublicHttpUrl } from '@stackpanel/net-guard';
import type { Prisma } from '@stackpanel/db';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';
import { toStringArray } from '../../lib/api-tokens.ts';
import { generateEd25519KeyPair, protectPrivateKey } from '../../reseller/keys.ts';
import { ResellerRepository } from '../../reseller/repository.ts';
import { SP_SCOPES } from '../sp-v1.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

/** 与 `apps/api/src/routes/sp-v1.ts` 的调用审计动作保持一致。 */
export const SP_V1_CALL_ACTION = 'sp_v1.call';

const pageSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const idParamSchema = z.object({ id: z.string().min(1).max(191) });

/** 回调地址必须为公网 HTTPS（审计 M-3），避免把渠道回调变成内网探测原语。 */
const webhookUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => isPublicHttpUrl(value), '回调地址必须为公网地址');

const SP_SCOPE_VALUES = Object.values(SP_SCOPES) as [string, ...string[]];

const createResellerSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.enum(SP_SCOPE_VALUES)).max(20).default([]),
    rateLimitRpm: z.number().int().min(0).max(100_000).default(240),
    webhookUrl: webhookUrlSchema.optional(),
  })
  .strict();

const updateResellerSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    scopes: z.array(z.enum(SP_SCOPE_VALUES)).max(20).optional(),
    rateLimitRpm: z.number().int().min(0).max(100_000).optional(),
    // 显式 null 表示清空回调地址；缺省表示不变。
    webhookUrl: webhookUrlSchema.nullable().optional(),
  })
  .strict();

/** 渠道密钥标识：便于运维肉眼区分，不与用户/渠道 id 耦合。 */
function generateKeyId(): string {
  return `sp_${randomBytes(12).toString('hex')}`;
}

const deliveryStatusSchema = z.enum(['PENDING', 'DELIVERING', 'SUCCEEDED', 'FAILED']);

type DeliveryRow = Prisma.WebhookDeliveryGetPayload<Record<string, never>>;

/** 渠道行/记录的公共投影输入（Prisma 行与仓储记录同形）。 */
interface ResellerLike {
  id: string;
  name: string;
  status: string;
  keyId: string;
  publicKey: string;
  webhookPrivateKey: string | null;
  webhookPublicKey: string | null;
  webhookUrl: string | null;
  scopes: unknown;
  rateLimitRpm: number;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Project a reseller row without ever leaking stored secrets. */
function publicReseller(row: ResellerLike) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    keyId: row.keyId,
    publicKey: row.publicKey,
    hasWebhookKey: row.webhookPrivateKey !== null,
    webhookPublicKey: row.webhookPublicKey,
    webhookUrl: row.webhookUrl,
    scopes: toStringArray(row.scopes),
    rateLimitRpm: row.rateLimitRpm,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function publicDelivery(row: DeliveryRow, resellerName: string | null = null) {
  return {
    id: row.id,
    resellerId: row.resellerId,
    resellerName,
    event: row.event,
    url: row.url,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    responseCode: row.responseCode,
    error: row.error,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function adminDeveloperRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------- overview ------------------------------- */
  app.get('/admin/developer/overview', { preHandler: adminOnly }, async () => {
    const prisma = getPrisma();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [resellerTotal, resellerActive, pending, failed, succeeded, calls24h, callsTotal] =
      await Promise.all([
        prisma.reseller.count(),
        prisma.reseller.count({ where: { status: 'ACTIVE' } }),
        prisma.webhookDelivery.count({ where: { status: { in: ['PENDING', 'DELIVERING'] } } }),
        prisma.webhookDelivery.count({ where: { status: 'FAILED' } }),
        prisma.webhookDelivery.count({ where: { status: 'SUCCEEDED' } }),
        prisma.auditLog.count({
          where: { action: SP_V1_CALL_ACTION, createdAt: { gte: since } },
        }),
        prisma.auditLog.count({ where: { action: SP_V1_CALL_ACTION } }),
      ]);
    return {
      overview: {
        resellers: { total: resellerTotal, active: resellerActive },
        webhookDeliveries: { pending, failed, succeeded },
        calls: { last24h: calls24h, total: callsTotal },
      },
    };
  });

  /* ------------------------------- resellers ------------------------------ */
  app.get('/admin/developer/resellers', { preHandler: adminOnly }, async (request, reply) => {
    const query = pageSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '查询参数无效' });
    const { page, pageSize } = query.data;
    const prisma = getPrisma();
    const [rows, total] = await Promise.all([
      prisma.reseller.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.reseller.count(),
    ]);
    return { resellers: rows.map(publicReseller), total, page, pageSize };
  });

  app.get('/admin/developer/resellers/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
    const prisma = getPrisma();
    const row = await prisma.reseller.findUnique({ where: { id: params.data.id } });
    if (!row) return reply.code(404).send({ error: '渠道不存在' });
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { resellerId: row.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return { reseller: publicReseller(row), deliveries: deliveries.map((d) => publicDelivery(d)) };
  });

  /* --------------------------- webhook deliveries ------------------------- */
  app.get('/admin/developer/webhook-deliveries', { preHandler: adminOnly }, async (request, reply) => {
    const query = pageSchema
      .extend({ resellerId: z.string().min(1).max(191).optional(), status: deliveryStatusSchema.optional() })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '查询参数无效' });
    const { page, pageSize, resellerId, status } = query.data;
    const where: Prisma.WebhookDeliveryWhereInput = {
      ...(resellerId ? { resellerId } : {}),
      ...(status ? { status } : {}),
    };
    const prisma = getPrisma();
    const [rows, total] = await Promise.all([
      prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { reseller: { select: { name: true } } },
      }),
      prisma.webhookDelivery.count({ where }),
    ]);
    return {
      deliveries: rows.map((row) => publicDelivery(row, row.reseller?.name ?? null)),
      total,
      page,
      pageSize,
    };
  });

  /* -------------------------------- calls --------------------------------- */
  app.get('/admin/developer/calls', { preHandler: adminOnly }, async (request, reply) => {
    const query = pageSchema
      .extend({ resellerId: z.string().min(1).max(191).optional() })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '查询参数无效' });
    const { page, pageSize, resellerId } = query.data;
    const where: Prisma.AuditLogWhereInput = {
      action: SP_V1_CALL_ACTION,
      ...(resellerId ? { resourceId: resellerId } : {}),
    };
    const prisma = getPrisma();
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);
    return { logs, total, page, pageSize };
  });

  /* --------------------------- 渠道生命周期（写） --------------------------- */

  app.post('/admin/developer/resellers', { preHandler: adminOnly }, async (request, reply) => {
    const body = createResellerSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: '请求参数无效' });
    const { name, scopes, rateLimitRpm, webhookUrl } = body.data;

    const inbound = generateEd25519KeyPair();
    let webhookPrivateKey: string | null = null;
    let webhookPublicKey: string | null = null;
    if (webhookUrl) {
      const webhook = generateEd25519KeyPair();
      try {
        webhookPrivateKey = protectPrivateKey(webhook.privateKey);
      } catch {
        return reply
          .code(409)
          .send({ error: '未配置 SETTINGS_ENCRYPTION_KEY，无法安全保存回调签名私钥' });
      }
      webhookPublicKey = webhook.publicKey;
    }

    const repo = new ResellerRepository(getPrisma());
    let created;
    try {
      created = await repo.create({
        id: `res_${randomUUID()}`,
        name,
        keyId: generateKeyId(),
        publicKey: inbound.publicKey,
        webhookPrivateKey,
        webhookPublicKey,
        webhookUrl: webhookUrl ?? null,
        scopes,
        rateLimitRpm,
      });
    } catch {
      return reply.code(409).send({ error: '渠道名称已存在' });
    }

    await writeAudit({
      action: 'developer.reseller.create',
      resource: 'reseller',
      resourceId: created.id,
      ...auditContext(request),
      meta: {
        name: created.name,
        keyId: created.keyId,
        scopes: created.scopes,
        hasWebhookKey: created.webhookPrivateKey !== null,
      },
    });
    // 入站私钥仅此一次返回；平台只保存公钥，之后不可检索。
    return { reseller: publicReseller(created), inboundPrivateKey: inbound.privateKey };
  });

  app.patch('/admin/developer/resellers/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const body = updateResellerSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: '请求参数无效' });
    const data = body.data;
    const repo = new ResellerRepository(getPrisma());
    const patch: Parameters<ResellerRepository['update']>[1] = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.status !== undefined) patch.status = data.status;
    if (data.scopes !== undefined) patch.scopes = data.scopes;
    if (data.rateLimitRpm !== undefined) patch.rateLimitRpm = data.rateLimitRpm;
    if (data.webhookUrl !== undefined) {
      patch.webhookUrl = data.webhookUrl;
      if (data.webhookUrl === null) {
        // Removing the endpoint also removes the stored signing material.
        patch.webhookPrivateKey = null;
        patch.webhookPublicKey = null;
      } else {
        // Every endpoint change gets a fresh key so a previous receiver cannot
        // continue authenticating events sent to the new endpoint.
        const webhook = generateEd25519KeyPair();
        try {
          patch.webhookPrivateKey = protectPrivateKey(webhook.privateKey);
        } catch {
          return reply
            .code(409)
            .send({ error: '未配置 SETTINGS_ENCRYPTION_KEY，无法安全保存回调签名私钥' });
        }
        patch.webhookPublicKey = webhook.publicKey;
      }
    }

    const updated = await repo.update(params.data.id, patch).catch(() => null);
    if (!updated) return reply.code(404).send({ error: '渠道不存在' });

    await writeAudit({
      action: 'developer.reseller.update',
      resource: 'reseller',
      resourceId: updated.id,
      ...auditContext(request),
      meta: { fields: Object.keys(patch) },
    });
    return { reseller: publicReseller(updated) };
  });

  app.post(
    '/admin/developer/resellers/:id/rotate-key',
    { preHandler: adminOnly },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
      const repo = new ResellerRepository(getPrisma());

      // Rotate the inbound key pair only. The callback key is untouched so
      // already-queued webhook deliveries remain signable.
      const inbound = generateEd25519KeyPair();
      const updated = await repo
        .update(params.data.id, { publicKey: inbound.publicKey })
        .catch(() => null);
      if (!updated) return reply.code(404).send({ error: '渠道不存在' });

      await writeAudit({
        action: 'developer.reseller.rotate-key',
        resource: 'reseller',
        resourceId: updated.id,
        ...auditContext(request),
        meta: { keyId: updated.keyId },
      });
      return { reseller: publicReseller(updated), inboundPrivateKey: inbound.privateKey };
    },
  );

  app.delete('/admin/developer/resellers/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
    const prisma = getPrisma();
    const repo = new ResellerRepository(prisma);
    const existing = await repo.findById(params.data.id);
    if (!existing) return reply.code(404).send({ error: '渠道不存在' });

    // Cascade deliveries first so a reseller row never dangles a delivery.
    await prisma.webhookDelivery.deleteMany({ where: { resellerId: existing.id } });
    await repo.delete(existing.id);

    await writeAudit({
      action: 'developer.reseller.delete',
      resource: 'reseller',
      resourceId: existing.id,
      ...auditContext(request),
      meta: { name: existing.name, keyId: existing.keyId },
    });
    return { deleted: true };
  });
}
