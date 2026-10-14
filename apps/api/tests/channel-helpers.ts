import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../src/plugins/prisma.ts';

/**
 * Test helpers for the channel plugin (ADR-0021 §D4).
 *
 * The channel domain now lives outside the kernel, in the channel plugin's own
 * Extension tables (`ext_channel_partner` / `ext_channel_delivery`). Tests seed
 * and inspect those tables directly with raw SQL (the same approach the store
 * tests use), so they exercise the plugin's HTTP surface end to end without
 * importing plugin internals.
 */

export const PARTNER_TABLE = 'ext_channel_partner';
export const DELIVERY_TABLE = 'ext_channel_delivery';

export interface SeedPartnerInput {
  id: string;
  name: string;
  keyId: string;
  publicKey: string;
  scopes?: string[];
  rateLimitRpm?: number;
  webhookUrl?: string | null;
  webhookPrivateKeyRef?: string | null;
  webhookPublicKey?: string | null;
  state?: string;
}

/** Enable a builtin plugin through the admin surface (mirrors the store tests). */
export async function enablePlugin(
  app: FastifyInstance,
  id: string,
  adminToken: string,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.plugin.deleteMany({ where: { id } });
  const res = await app.inject({
    method: 'PATCH',
    url: `/admin/plugins/${id}`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { enabled: true },
  });
  if (res.statusCode !== 200) {
    throw new Error(`启用插件 ${id} 失败：${res.statusCode} ${res.body}`);
  }
}

/** Insert a channel partner row directly into the plugin's Extension table. */
export async function seedPartner(input: SeedPartnerInput): Promise<void> {
  const spec = {
    name: input.name,
    state: input.state ?? 'ACTIVE',
    keyId: input.keyId,
    publicKey: input.publicKey,
    webhookPrivateKeyRef: input.webhookPrivateKeyRef ?? null,
    webhookPublicKey: input.webhookPublicKey ?? null,
    webhookUrl: input.webhookUrl ?? null,
    scopes: input.scopes ?? [],
    rateLimitRpm: input.rateLimitRpm ?? 0,
    lastUsedAt: null,
    lastUsedIp: null,
  };
  await getPrisma().$executeRawUnsafe(
    `INSERT INTO "${PARTNER_TABLE}"
       ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
        "created_at", "updated_at", "f_name", "f_keyId", "f_state")
     VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
             now(), now(), $3, $4, $5)`,
    input.id,
    JSON.stringify(spec),
    input.name,
    input.keyId,
    spec.state,
  );
}

/** Insert a webhook delivery row directly into the plugin's Extension table. */
export async function seedDelivery(input: {
  id: string;
  partnerId: string;
  event: string;
  url: string;
  payload: unknown;
  maxAttempts?: number;
  state?: string;
  attempts?: number;
  nextAttemptAt?: number;
}): Promise<void> {
  const spec = {
    partnerId: input.partnerId,
    event: input.event,
    url: input.url,
    payload: input.payload,
    state: input.state ?? 'PENDING',
    attempts: input.attempts ?? 0,
    maxAttempts: input.maxAttempts ?? 6,
    responseCode: null,
    error: null,
    nextAttemptAt: input.nextAttemptAt ?? 0,
    deliveredAt: null,
  };
  await getPrisma().$executeRawUnsafe(
    `INSERT INTO "${DELIVERY_TABLE}"
       ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
        "created_at", "updated_at", "f_partnerId", "f_state", "f_attempts", "f_nextAttemptAt")
     VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
             now(), now(), $3, $4, $5, $6)`,
    input.id,
    JSON.stringify(spec),
    input.partnerId,
    spec.state,
    spec.attempts,
    spec.nextAttemptAt,
  );
}

/** Delete a partner and any deliveries that belong to it. */
export async function deletePartner(id: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.$executeRawUnsafe(`DELETE FROM "${DELIVERY_TABLE}" WHERE "f_partnerId" = $1`, id);
  await prisma.$executeRawUnsafe(`DELETE FROM "${PARTNER_TABLE}" WHERE "id" = $1`, id);
}
