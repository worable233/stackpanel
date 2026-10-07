/**
 * Reseller + webhook persistence (SP-V1). Raw SQL on purpose: the `resellers`
 * and `webhook_deliveries` tables are a KERNEL-owned migration shipped at merge
 * time, so this adapter typechecks and builds before `prisma generate` has seen
 * the models (same reasoning as MEDIA's attachment repository).
 *
 * Before the migration lands, reads degrade gracefully (empty / null) and the
 * signature guard surfaces a clear failure rather than crashing the process.
 */
import type { PrismaClient } from '@stackpanel/db';
import { toStringArray } from '../lib/api-tokens.ts';

export interface ResellerRecord {
  id: string;
  name: string;
  status: string;
  keyId: string;
  publicKey: string;
  webhookPrivateKey: string | null;
  webhookPublicKey: string | null;
  webhookUrl: string | null;
  scopes: string[];
  rateLimitRpm: number;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDeliveryRecord {
  id: string;
  resellerId: string;
  event: string;
  url: string;
  payload: unknown;
  status: string;
  attempts: number;
  maxAttempts: number;
  responseCode: number | null;
  error: string | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ResellerRow {
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

function mapReseller(row: ResellerRow): ResellerRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    keyId: row.keyId,
    publicKey: row.publicKey,
    webhookPrivateKey: row.webhookPrivateKey,
    webhookPublicKey: row.webhookPublicKey,
    webhookUrl: row.webhookUrl,
    scopes: toStringArray(row.scopes),
    rateLimitRpm: Number(row.rateLimitRpm),
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Prisma 7 surfaces a missing relation as P2021; a missing table also 42P01. */
function isMissingTable(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? '';
  return code === 'P2021' || message.includes('does not exist') || message.includes('42P01');
}

export class ResellerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByKeyId(keyId: string): Promise<ResellerRecord | null> {
    try {
      const rows = await this.prisma.$queryRaw<ResellerRow[]>`
        SELECT * FROM "resellers" WHERE "keyId" = ${keyId} LIMIT 1
      `;
      return rows[0] ? mapReseller(rows[0]) : null;
    } catch (err) {
      if (isMissingTable(err)) return null;
      throw err;
    }
  }

  async findById(id: string): Promise<ResellerRecord | null> {
    try {
      const rows = await this.prisma.$queryRaw<ResellerRow[]>`
        SELECT * FROM "resellers" WHERE "id" = ${id} LIMIT 1
      `;
      return rows[0] ? mapReseller(rows[0]) : null;
    } catch (err) {
      if (isMissingTable(err)) return null;
      throw err;
    }
  }

  async list(limit = 200): Promise<ResellerRecord[]> {
    try {
      const rows = await this.prisma.$queryRaw<ResellerRow[]>`
        SELECT * FROM "resellers" ORDER BY "createdAt" DESC
        LIMIT ${Math.max(1, Math.min(limit, 500))}
      `;
      return rows.map(mapReseller);
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  /** Best-effort `lastUsedAt`/`lastUsedIp` touch, throttled to avoid a write per request. */
  async touch(id: string, ip: string | undefined): Promise<void> {
    await this.prisma
      .$executeRaw`
        UPDATE "resellers"
        SET "lastUsedAt" = CURRENT_TIMESTAMP, "lastUsedIp" = ${ip ?? null}
        WHERE "id" = ${id}
      `
      .catch(() => undefined);
  }

  async create(input: {
    id: string;
    name: string;
    keyId: string;
    publicKey: string;
    webhookPrivateKey?: string | null;
    webhookPublicKey?: string | null;
    webhookUrl?: string | null;
    scopes: string[];
    rateLimitRpm: number;
  }): Promise<ResellerRecord> {
    const rows = await this.prisma.$queryRaw<ResellerRow[]>`
      INSERT INTO "resellers"
        ("id", "name", "keyId", "publicKey", "webhookPrivateKey", "webhookPublicKey",
         "webhookUrl", "scopes", "rateLimitRpm", "updatedAt")
      VALUES (
        ${input.id}, ${input.name}, ${input.keyId}, ${input.publicKey},
        ${input.webhookPrivateKey ?? null}, ${input.webhookPublicKey ?? null},
        ${input.webhookUrl ?? null}, ${JSON.stringify(input.scopes)}::jsonb,
        ${input.rateLimitRpm}, CURRENT_TIMESTAMP
      )
      RETURNING *
    `;
    const row = rows[0];
    if (!row) throw new Error('SP v1: 渠道创建失败');
    return mapReseller(row);
  }

  async update(
    id: string,
    patch: {
      name?: string;
      status?: string;
      publicKey?: string;
      webhookPrivateKey?: string | null;
      webhookPublicKey?: string | null;
      /** `null` clears the callback URL; omit the key to leave it unchanged. */
      webhookUrl?: string | null;
      scopes?: string[];
      rateLimitRpm?: number;
    },
  ): Promise<ResellerRecord | null> {
    // `webhookUrl` uses an explicit-presence switch: COALESCE alone cannot tell
    // "clear the URL" (null) from "leave unchanged" (absent).
    const setWebhookUrl = Object.prototype.hasOwnProperty.call(patch, 'webhookUrl');
    const setWebhookPrivateKey = Object.prototype.hasOwnProperty.call(patch, 'webhookPrivateKey');
    const setWebhookPublicKey = Object.prototype.hasOwnProperty.call(patch, 'webhookPublicKey');
    const rows = await this.prisma.$queryRaw<ResellerRow[]>`
      UPDATE "resellers" SET
        "name" = COALESCE(${patch.name ?? null}, "name"),
        "status" = COALESCE(${patch.status ?? null}, "status"),
        "publicKey" = COALESCE(${patch.publicKey ?? null}, "publicKey"),
        "webhookPrivateKey" = CASE WHEN ${setWebhookPrivateKey}::boolean
                                    THEN ${patch.webhookPrivateKey ?? null}
                                    ELSE "webhookPrivateKey" END,
        "webhookPublicKey" = CASE WHEN ${setWebhookPublicKey}::boolean
                                   THEN ${patch.webhookPublicKey ?? null}
                                   ELSE "webhookPublicKey" END,
        "webhookUrl" = CASE WHEN ${setWebhookUrl}::boolean
                            THEN ${patch.webhookUrl ?? null} ELSE "webhookUrl" END,
        "scopes" = COALESCE(${patch.scopes ? JSON.stringify(patch.scopes) : null}::jsonb, "scopes"),
        "rateLimitRpm" = COALESCE(${patch.rateLimitRpm ?? null}, "rateLimitRpm"),
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}
      RETURNING *
    `;
    return rows[0] ? mapReseller(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM "resellers" WHERE "id" = ${id}`;
  }

  // --- Webhook deliveries ---------------------------------------------------

  async createDelivery(input: {
    id: string;
    resellerId: string;
    event: string;
    url: string;
    payload: unknown;
    maxAttempts: number;
  }): Promise<WebhookDeliveryRecord> {
    const rows = await this.prisma.$queryRaw<WebhookDeliveryRecord[]>`
      INSERT INTO "webhook_deliveries"
        ("id", "resellerId", "event", "url", "payload", "maxAttempts", "updatedAt")
      VALUES (
        ${input.id}, ${input.resellerId}, ${input.event}, ${input.url},
        ${JSON.stringify(input.payload)}::jsonb, ${input.maxAttempts}, CURRENT_TIMESTAMP
      )
      RETURNING *
    `;
    const row = rows[0];
    if (!row) throw new Error('SP v1: webhook 记录写入失败');
    return row;
  }

  async findDelivery(id: string): Promise<WebhookDeliveryRecord | null> {
    const rows = await this.prisma.$queryRaw<WebhookDeliveryRecord[]>`
      SELECT * FROM "webhook_deliveries" WHERE "id" = ${id} LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async listDeliveries(resellerId: string | undefined, limit = 100): Promise<WebhookDeliveryRecord[]> {
    const take = Math.max(1, Math.min(limit, 200));
    if (resellerId) {
      return this.prisma.$queryRaw<WebhookDeliveryRecord[]>`
        SELECT * FROM "webhook_deliveries" WHERE "resellerId" = ${resellerId}
        ORDER BY "createdAt" DESC LIMIT ${take}
      `;
    }
    return this.prisma.$queryRaw<WebhookDeliveryRecord[]>`
      SELECT * FROM "webhook_deliveries" ORDER BY "createdAt" DESC LIMIT ${take}
    `;
  }

  /** Atomically claim a due delivery for one runner (PENDING -> DELIVERING). */
  async claimDelivery(id: string): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "webhook_deliveries"
      SET "status" = 'DELIVERING', "attempts" = "attempts" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id} AND "status" = 'PENDING'
    `;
    return count > 0;
  }

  async dueDeliveries(now = new Date(), take = 20): Promise<WebhookDeliveryRecord[]> {
    return this.prisma.$queryRaw<WebhookDeliveryRecord[]>`
      SELECT * FROM "webhook_deliveries"
      WHERE "status" = 'PENDING'
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
      ORDER BY "createdAt" ASC
      LIMIT ${take}
    `;
  }

  async markDelivered(id: string, responseCode: number | null): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "webhook_deliveries"
      SET "status" = 'SUCCEEDED', "responseCode" = ${responseCode}, "error" = NULL,
          "deliveredAt" = CURRENT_TIMESTAMP, "nextAttemptAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}
    `;
  }

  async markRetry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "webhook_deliveries"
      SET "status" = 'PENDING', "error" = ${error}, "nextAttemptAt" = ${nextAttemptAt},
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}
    `;
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "webhook_deliveries"
      SET "status" = 'FAILED', "error" = ${error}, "nextAttemptAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}
    `;
  }
}

/** Whether the SP v1 tables are reachable (ready/probe guard). */
export async function resellerTablesReady(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "resellers" LIMIT 1`;
    return true;
  } catch (err) {
    if (isMissingTable(err)) return false;
    throw err;
  }
}
