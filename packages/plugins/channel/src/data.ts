import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * 渠道插件自治数据模型（ADR-0008 / ADR-0009；迁移自内核
 * `resellers` / `webhook_deliveries`，ADR-0021 §D4）。
 *
 * 约定：实体生命周期字段命名为 `state`，以便 `ctx.extensions.updateWhere`
 * 把「按状态条件原子变更」落到真实索引列（见 store 插件同款说明）。对外仍以
 * `status` 暴露。
 */

/** 渠道伙伴（上游渠道 / 开放平台伙伴）。 */
export const partnerModel = defineModel({
  kind: 'channel/partner',
  label: '渠道伙伴',
  schema: z.object({
    name: z.string(),
    /** 生命周期：ACTIVE | DISABLED（对外称 status）。 */
    state: z.string().default('ACTIVE'),
    /** 入站签名公钥标识（`sp_<hex>`）与 Ed25519 公钥（PEM）。 */
    keyId: z.string(),
    publicKey: z.string(),
    /** 出站回调签名私钥的密钥库引用（引用 ctx.secrets，绝不落明文）。 */
    webhookPrivateKeyRef: z.string().nullable().default(null),
    webhookPublicKey: z.string().nullable().default(null),
    webhookUrl: z.string().nullable().default(null),
    scopes: z.array(z.string()).default([]),
    rateLimitRpm: z.number().int().default(240),
    lastUsedAt: z.string().nullable().default(null),
    lastUsedIp: z.string().nullable().default(null),
  }),
  indexes: [
    { fields: ['name'], unique: true, types: { name: 'string' } },
    { fields: ['keyId'], unique: true, types: { keyId: 'string' } },
    { fields: ['state'], types: { state: 'string' } },
  ],
});

/** 签名 webhook 投递记录（出站回调，at-least-once + 退避重试）。 */
export const deliveryModel = defineModel({
  kind: 'channel/delivery',
  label: '渠道回调投递',
  schema: z.object({
    partnerId: z.string(),
    event: z.string(),
    url: z.string(),
    payload: z.unknown(),
    /** 生命周期：PENDING | DELIVERING | SUCCEEDED | FAILED（对外称 status）。 */
    state: z.string().default('PENDING'),
    attempts: z.number().int().default(0),
    maxAttempts: z.number().int().default(6),
    responseCode: z.number().int().nullable().default(null),
    error: z.string().nullable().default(null),
    /** Earliest next attempt, epoch ms (0 = due immediately). */
    nextAttemptAt: z.number().int().default(0),
    deliveredAt: z.string().nullable().default(null),
  }),
  indexes: [
    { fields: ['partnerId'], types: { partnerId: 'string' } },
    { fields: ['state'], types: { state: 'string' } },
    { fields: ['attempts'], types: { attempts: 'integer' } },
    { fields: ['nextAttemptAt'], types: { nextAttemptAt: 'integer' } },
  ],
});
