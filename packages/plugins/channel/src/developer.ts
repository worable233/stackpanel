/**
 * 开发者控制台（开放平台；owner: channel plugin，ADR-0021 §D4 迁出内核）。
 *
 * 三个横切面：
 *   - 渠道伙伴：SP v1 入站身份的密钥、scope、限额与最近使用；
 *   - webhook 投递：出站回调的 at-least-once 投递状态；
 *   - 调用审计：伙伴对 `/sp/v1/*` 的调用轨迹（经 `ctx.auth.listAuditLogs` 读取）。
 *
 * 路由路径与内核时代**完全一致**（`/admin/developer/*`），故 web 管理端与 SDK
 * 客户端零改动。写操作经 `ctx.auth.audit` 落审计；回调私钥存 `ctx.secrets`，永不出圈。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { HttpReply, HttpRequest } from '@stackpanel/sdk';
import { isPublicHttpUrl } from '@stackpanel/net-guard';
import { context } from './context';
import { ChannelError } from './errors';
import { ChannelRepository, type PartnerRecord, type DeliveryRecord } from './repository';
import {
  forgetWebhookPrivateKey,
  generateEd25519KeyPair,
  protectWebhookPrivateKey,
} from './keys';
import { SP_SCOPES } from './sp-v1';

/** 与 `/sp/v1/*` 调用审计动作保持一致。 */
export const SP_V1_CALL_ACTION = 'sp_v1.call';

const pageSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const idParamSchema = z.string().min(1).max(191);

const webhookUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => isPublicHttpUrl(value), '回调地址必须为公网地址');

const SP_SCOPE_VALUES = Object.values(SP_SCOPES) as [string, ...string[]];

const createPartnerSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.enum(SP_SCOPE_VALUES)).max(20).default([]),
    rateLimitRpm: z.number().int().min(0).max(100_000).default(240),
    webhookUrl: webhookUrlSchema.optional(),
  })
  .strict();

const updatePartnerSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    scopes: z.array(z.enum(SP_SCOPE_VALUES)).max(20).optional(),
    rateLimitRpm: z.number().int().min(0).max(100_000).optional(),
    webhookUrl: webhookUrlSchema.nullable().optional(),
  })
  .strict();

function generateKeyId(): string {
  return `sp_${randomBytes(12).toString('hex')}`;
}

function problem(status: number, detail: string, title?: string): Record<string, unknown> {
  return {
    type: 'about:blank',
    title: title ?? (status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Bad Request'),
    status,
    detail,
  };
}

function send(reply: HttpReply, status: number, body: unknown): void {
  reply.code(status).send(body);
}

/** Project a partner without ever leaking stored secrets. */
function publicPartner(row: PartnerRecord) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    keyId: row.keyId,
    publicKey: row.publicKey,
    hasWebhookKey: row.webhookPrivateKeyRef !== null,
    webhookPublicKey: row.webhookPublicKey,
    webhookUrl: row.webhookUrl,
    scopes: row.scopes,
    rateLimitRpm: row.rateLimitRpm,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function publicDelivery(row: DeliveryRecord, partnerName: string | null = null) {
  return {
    id: row.id,
    resellerId: row.partnerId,
    resellerName: partnerName,
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

function parseQuery(request: HttpRequest): Record<string, unknown> {
  return { ...request.query };
}

interface AdminAudit {
  actorId?: string;
  ip?: string;
  userAgent?: string;
}

function auditOf(request: HttpRequest): AdminAudit {
  const ua = request.headers['user-agent'];
  return {
    ...(request.user?.id ? { actorId: request.user.id } : {}),
    ...(request.ip ? { ip: request.ip } : {}),
    ...(typeof ua === 'string' ? { userAgent: ua } : {}),
  };
}

/** Wrap a handler so ChannelError becomes a stable problem response. */
function handle(action: (request: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (request: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await action(request, reply);
    } catch (error) {
      if (error instanceof ChannelError) {
        send(reply, error.status, problem(error.status, error.message));
        return reply;
      }
      throw error;
    }
  };
}

/* ------------------------------- overview ------------------------------- */

export const developerOverview = handle(async () => {
  const repo = new ChannelRepository();
  const [partners, deliveries, calls24h, callsTotal] = await Promise.all([
    repo.list(1, 200),
    repo.listDeliveries(undefined, 200),
    context().auth.listAuditLogs({
      action: SP_V1_CALL_ACTION,
      since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      page: 1,
      pageSize: 1,
    }),
    context().auth.listAuditLogs({ action: SP_V1_CALL_ACTION, page: 1, pageSize: 1 }),
  ]);
  const active = partners.items.filter((p) => p.status === 'ACTIVE').length;
  const pending = deliveries.filter((d) => d.status === 'PENDING' || d.status === 'DELIVERING').length;
  const failed = deliveries.filter((d) => d.status === 'FAILED').length;
  const succeeded = deliveries.filter((d) => d.status === 'SUCCEEDED').length;
  return {
    overview: {
      resellers: { total: partners.total, active },
      webhookDeliveries: { pending, failed, succeeded },
      calls: { last24h: calls24h.total, total: callsTotal.total },
    },
  };
});

/* ------------------------------- partners ------------------------------- */

export const listPartners = handle(async (request, reply) => {
  const query = pageSchema.safeParse(parseQuery(request));
  if (!query.success) return send(reply, 400, { error: '查询参数无效' });
  const repo = new ChannelRepository();
  const { items, total } = await repo.list(query.data.page, query.data.pageSize);
  return { resellers: items.map(publicPartner), total, page: query.data.page, pageSize: query.data.pageSize };
});

export const getPartner = handle(async (request, reply) => {
  const id = idParamSchema.safeParse(request.params['id']);
  if (!id.success) return send(reply, 400, { error: '请求参数无效' });
  const repo = new ChannelRepository();
  const row = await repo.findById(id.data);
  if (!row) return send(reply, 404, { error: '渠道不存在' });
  const deliveries = await repo.listDeliveries(row.id, 20);
  return { reseller: publicPartner(row), deliveries: deliveries.map((d) => publicDelivery(d)) };
});

/* --------------------------- webhook deliveries ------------------------- */

const deliveryStatusSchema = z.enum(['PENDING', 'DELIVERING', 'SUCCEEDED', 'FAILED']);

export const listDeliveries = handle(async (request, reply) => {
  const query = pageSchema
    .extend({
      resellerId: z.string().min(1).max(191).optional(),
      status: deliveryStatusSchema.optional(),
    })
    .safeParse(parseQuery(request));
  if (!query.success) return send(reply, 400, { error: '查询参数无效' });
  const { page, pageSize, resellerId, status } = query.data;
  const repo = new ChannelRepository();
  const { items, total } = await repo.listDeliveriesPaged(resellerId, page, pageSize, status);
  const names = new Map<string, string>();
  const deliveries = items.map((d) => publicDelivery(d));
  // Attach partner names (only for the page's distinct partners).
  const partnerIds = [...new Set(items.map((d) => d.partnerId))];
  await Promise.all(
    partnerIds.map(async (pid) => {
      const partner = await repo.findById(pid);
      if (partner) names.set(pid, partner.name);
    }),
  );
  for (const delivery of deliveries) delivery.resellerName = names.get(delivery.resellerId) ?? null;
  return { deliveries, total, page, pageSize };
});

/* -------------------------------- calls --------------------------------- */

export const listCalls = handle(async (request, reply) => {
  const query = pageSchema
    .extend({ resellerId: z.string().min(1).max(191).optional() })
    .safeParse(parseQuery(request));
  if (!query.success) return send(reply, 400, { error: '查询参数无效' });
  const { page, pageSize, resellerId } = query.data;
  const result = await context().auth.listAuditLogs({
    action: SP_V1_CALL_ACTION,
    ...(resellerId ? { resourceId: resellerId } : {}),
    page,
    pageSize,
  });
  return result;
});

/* --------------------------- partner lifecycle -------------------------- */

export const createPartner = handle(async (request, reply) => {
  const body = createPartnerSchema.safeParse(request.body);
  if (!body.success) return send(reply, 400, { error: '请求参数无效' });
  const { name, scopes, rateLimitRpm, webhookUrl } = body.data;
  const id = `res_${randomUUID()}`;

  const inbound = generateEd25519KeyPair();
  let webhookPrivateKeyRef: string | null = null;
  let webhookPublicKey: string | null = null;
  if (webhookUrl) {
    const webhook = generateEd25519KeyPair();
    try {
      webhookPrivateKeyRef = await protectWebhookPrivateKey(id, webhook.privateKey);
    } catch {
      return send(reply, 409, {
        error: '未配置 SETTINGS_ENCRYPTION_KEY，无法安全保存回调签名私钥',
      });
    }
    webhookPublicKey = webhook.publicKey;
  }

  const repo = new ChannelRepository();
  let created: PartnerRecord;
  try {
    created = await repo.create({
      id,
      name,
      keyId: generateKeyId(),
      publicKey: inbound.publicKey,
      webhookPrivateKeyRef,
      webhookPublicKey,
      webhookUrl: webhookUrl ?? null,
      scopes,
      rateLimitRpm,
    });
  } catch {
    await forgetWebhookPrivateKey(webhookPrivateKeyRef);
    return send(reply, 409, { error: '渠道名称已存在' });
  }

  const audit = auditOf(request);
  await context()
    .auth.audit({
      action: 'developer.reseller.create',
      resource: 'reseller',
      resourceId: created.id,
      ...audit,
      meta: {
        name: created.name,
        keyId: created.keyId,
        scopes: created.scopes,
        hasWebhookKey: created.webhookPrivateKeyRef !== null,
      },
    })
    .catch(() => undefined);
  // 入站私钥仅此一次返回；平台只保存公钥。
  return { reseller: publicPartner(created), inboundPrivateKey: inbound.privateKey };
});

export const updatePartner = handle(async (request, reply) => {
  const id = idParamSchema.safeParse(request.params['id']);
  const body = updatePartnerSchema.safeParse(request.body);
  if (!id.success || !body.success) return send(reply, 400, { error: '请求参数无效' });
  const data = body.data;

  const repo = new ChannelRepository();
  const existing = await repo.findById(id.data);
  if (!existing) return send(reply, 404, { error: '渠道不存在' });

  const patch: Parameters<ChannelRepository['update']>[1] = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.status !== undefined) patch.status = data.status;
  if (data.scopes !== undefined) patch.scopes = data.scopes;
  if (data.rateLimitRpm !== undefined) patch.rateLimitRpm = data.rateLimitRpm;
  if (data.webhookUrl !== undefined) {
    patch.webhookUrl = data.webhookUrl;
    const oldRef = existing.webhookPrivateKeyRef;
    if (data.webhookUrl === null) {
      patch.webhookPrivateKeyRef = null;
      patch.webhookPublicKey = null;
      await forgetWebhookPrivateKey(oldRef);
    } else {
      const webhook = generateEd25519KeyPair();
      try {
        patch.webhookPrivateKeyRef = await protectWebhookPrivateKey(existing.id, webhook.privateKey);
      } catch {
        return send(reply, 409, {
          error: '未配置 SETTINGS_ENCRYPTION_KEY，无法安全保存回调签名私钥',
        });
      }
      patch.webhookPublicKey = webhook.publicKey;
    }
  }

  const updated = await repo.update(id.data, patch).catch(() => null);
  if (!updated) return send(reply, 404, { error: '渠道不存在' });

  const audit = auditOf(request);
  await context()
    .auth.audit({
      action: 'developer.reseller.update',
      resource: 'reseller',
      resourceId: updated.id,
      ...audit,
      meta: { fields: Object.keys(patch) },
    })
    .catch(() => undefined);
  return { reseller: publicPartner(updated) };
});

export const rotatePartnerKey = handle(async (request, reply) => {
  const id = idParamSchema.safeParse(request.params['id']);
  if (!id.success) return send(reply, 400, { error: '请求参数无效' });
  const repo = new ChannelRepository();

  // Rotate only the inbound key pair; the callback key is untouched so queued
  // deliveries remain signable.
  const inbound = generateEd25519KeyPair();
  const updated = await repo.update(id.data, { publicKey: inbound.publicKey }).catch(() => null);
  if (!updated) return send(reply, 404, { error: '渠道不存在' });

  const audit = auditOf(request);
  await context()
    .auth.audit({
      action: 'developer.reseller.rotate-key',
      resource: 'reseller',
      resourceId: updated.id,
      ...audit,
      meta: { keyId: updated.keyId },
    })
    .catch(() => undefined);
  return { reseller: publicPartner(updated), inboundPrivateKey: inbound.privateKey };
});

export const deletePartner = handle(async (request, reply) => {
  const id = idParamSchema.safeParse(request.params['id']);
  if (!id.success) return send(reply, 400, { error: '请求参数无效' });
  const repo = new ChannelRepository();
  const existing = await repo.findById(id.data);
  if (!existing) return send(reply, 404, { error: '渠道不存在' });

  // Cascade deliveries first so a partner never dangles a delivery.
  await repo.deleteDeliveriesForPartner(existing.id);
  await forgetWebhookPrivateKey(existing.webhookPrivateKeyRef);
  await repo.delete(existing.id);

  const audit = auditOf(request);
  await context()
    .auth.audit({
      action: 'developer.reseller.delete',
      resource: 'reseller',
      resourceId: existing.id,
      ...audit,
      meta: { name: existing.name, keyId: existing.keyId },
    })
    .catch(() => undefined);
  return { deleted: true };
});
