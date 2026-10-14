/**
 * Channel partner + webhook delivery persistence (ADR-0021 §D4).
 *
 * Moved out of the kernel (formerly raw SQL over `resellers` /
 * `webhook_deliveries`) onto the plugin's own Extension models; the kernel no
 * longer owns these tables. `state` maps to the public `status`.
 */
import type { ExtensionInstance } from '@stackpanel/sdk';
import { extensions } from './context';
import { ChannelError } from './errors';
import { deliveryModel, partnerModel } from './data';

export interface PartnerRecord {
  id: string;
  name: string;
  status: string;
  keyId: string;
  publicKey: string;
  webhookPrivateKeyRef: string | null;
  webhookPublicKey: string | null;
  webhookUrl: string | null;
  scopes: string[];
  rateLimitRpm: number;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryRecord {
  id: string;
  partnerId: string;
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

interface PartnerSpec {
  name: string;
  state: string;
  keyId: string;
  publicKey: string;
  webhookPrivateKeyRef: string | null;
  webhookPublicKey: string | null;
  webhookUrl: string | null;
  scopes: string[];
  rateLimitRpm: number;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
}

interface DeliverySpec {
  partnerId: string;
  event: string;
  url: string;
  payload: unknown;
  state: string;
  attempts: number;
  maxAttempts: number;
  responseCode: number | null;
  error: string | null;
  nextAttemptAt: number;
  deliveredAt: string | null;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapPartner(instance: ExtensionInstance<PartnerSpec>): PartnerRecord {
  const spec = instance.spec;
  return {
    id: instance.name,
    name: spec.name,
    status: spec.state,
    keyId: spec.keyId,
    publicKey: spec.publicKey,
    webhookPrivateKeyRef: spec.webhookPrivateKeyRef ?? null,
    webhookPublicKey: spec.webhookPublicKey ?? null,
    webhookUrl: spec.webhookUrl ?? null,
    scopes: Array.isArray(spec.scopes) ? spec.scopes : [],
    rateLimitRpm: Number(spec.rateLimitRpm ?? 240),
    lastUsedAt: toDate(spec.lastUsedAt),
    lastUsedIp: spec.lastUsedIp ?? null,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

function mapDelivery(instance: ExtensionInstance<DeliverySpec>): DeliveryRecord {
  const spec = instance.spec;
  return {
    id: instance.name,
    partnerId: spec.partnerId,
    event: spec.event,
    url: spec.url,
    payload: spec.payload,
    status: spec.state,
    attempts: Number(spec.attempts ?? 0),
    maxAttempts: Number(spec.maxAttempts ?? 6),
    responseCode: spec.responseCode ?? null,
    error: spec.error ?? null,
    nextAttemptAt: spec.nextAttemptAt > 0 ? new Date(spec.nextAttemptAt) : null,
    deliveredAt: toDate(spec.deliveredAt),
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

export class ChannelRepository {
  async findByKeyId(keyId: string): Promise<PartnerRecord | null> {
    const { items } = await extensions().list<PartnerSpec>(partnerModel, {
      where: { keyId: { eq: keyId } },
      page: 1,
      pageSize: 1,
    });
    const first = items[0];
    return first ? mapPartner(first) : null;
  }

  async findById(id: string): Promise<PartnerRecord | null> {
    const instance = await extensions().get<PartnerSpec>(partnerModel, id);
    return instance ? mapPartner(instance) : null;
  }

  async list(page = 1, pageSize = 20): Promise<{ items: PartnerRecord[]; total: number }> {
    const result = await extensions().list<PartnerSpec>(partnerModel, {
      orderBy: { field: 'createdAt', desc: true },
      page,
      pageSize,
    });
    return { items: result.items.map(mapPartner), total: result.total };
  }

  /** Best-effort `lastUsedAt`/`lastUsedIp` touch; never throws to the caller. */
  async touch(id: string, ip: string | undefined): Promise<void> {
    const existing = await extensions()
      .get<PartnerSpec>(partnerModel, id)
      .catch(() => null);
    if (!existing) return;
    await extensions()
      .update<PartnerSpec>(partnerModel, id, {
        ...existing.spec,
        lastUsedAt: new Date().toISOString(),
        lastUsedIp: ip ?? null,
      })
      .catch(() => undefined);
  }

  async create(input: {
    id: string;
    name: string;
    keyId: string;
    publicKey: string;
    webhookPrivateKeyRef?: string | null;
    webhookPublicKey?: string | null;
    webhookUrl?: string | null;
    scopes: string[];
    rateLimitRpm: number;
  }): Promise<PartnerRecord> {
    const instance = await extensions().create<PartnerSpec>(
      partnerModel,
      {
        name: input.name,
        state: 'ACTIVE',
        keyId: input.keyId,
        publicKey: input.publicKey,
        webhookPrivateKeyRef: input.webhookPrivateKeyRef ?? null,
        webhookPublicKey: input.webhookPublicKey ?? null,
        webhookUrl: input.webhookUrl ?? null,
        scopes: input.scopes,
        rateLimitRpm: input.rateLimitRpm,
        lastUsedAt: null,
        lastUsedIp: null,
      },
      { name: input.id },
    );
    return mapPartner(instance);
  }

  async update(
    id: string,
    patch: {
      name?: string;
      status?: string;
      publicKey?: string;
      webhookPrivateKeyRef?: string | null;
      webhookPublicKey?: string | null;
      /** `null` clears the callback URL; omit the key to leave it unchanged. */
      webhookUrl?: string | null;
      scopes?: string[];
      rateLimitRpm?: number;
    },
  ): Promise<PartnerRecord | null> {
    const existing = await extensions()
      .get<PartnerSpec>(partnerModel, id)
      .catch(() => null);
    if (!existing) return null;
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(patch, key);
    const next: PartnerSpec = {
      ...existing.spec,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.status !== undefined ? { state: patch.status } : {}),
      ...(patch.publicKey !== undefined ? { publicKey: patch.publicKey } : {}),
      ...(has('webhookPrivateKeyRef')
        ? { webhookPrivateKeyRef: patch.webhookPrivateKeyRef ?? null }
        : {}),
      ...(has('webhookPublicKey') ? { webhookPublicKey: patch.webhookPublicKey ?? null } : {}),
      ...(has('webhookUrl') ? { webhookUrl: patch.webhookUrl ?? null } : {}),
      ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
      ...(patch.rateLimitRpm !== undefined ? { rateLimitRpm: patch.rateLimitRpm } : {}),
    };
    try {
      const updated = await extensions().update<PartnerSpec>(partnerModel, id, next);
      return mapPartner(updated);
    } catch (error) {
      // Preserve the original "name already exists" contract for the caller.
      if ((error as { code?: string }).code === 'extension.unique_violation') {
        throw new ChannelError(409, '渠道名称已存在');
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await extensions().delete(partnerModel, id);
  }

  /** Delete every delivery belonging to a partner. */
  async deleteDeliveriesForPartner(partnerId: string): Promise<void> {
    const items = await extensions().listAll<DeliverySpec>(deliveryModel, {
      where: { partnerId: { eq: partnerId } },
    });
    for (const item of items) {
      await extensions()
        .delete(deliveryModel, item.name)
        .catch(() => undefined);
    }
  }

  // --- Webhook deliveries ---------------------------------------------------

  async createDelivery(input: {
    id: string;
    partnerId: string;
    event: string;
    url: string;
    payload: unknown;
    maxAttempts: number;
  }): Promise<DeliveryRecord> {
    const instance = await extensions().create<DeliverySpec>(
      deliveryModel,
      {
        partnerId: input.partnerId,
        event: input.event,
        url: input.url,
        payload: input.payload,
        state: 'PENDING',
        attempts: 0,
        maxAttempts: input.maxAttempts,
        responseCode: null,
        error: null,
        nextAttemptAt: 0,
        deliveredAt: null,
      },
      { name: input.id },
    );
    return mapDelivery(instance);
  }

  async findDelivery(id: string): Promise<DeliveryRecord | null> {
    const instance = await extensions().get<DeliverySpec>(deliveryModel, id);
    return instance ? mapDelivery(instance) : null;
  }

  async listDeliveries(
    partnerId: string | undefined,
    limit = 100,
  ): Promise<DeliveryRecord[]> {
    const take = Math.max(1, Math.min(limit, 200));
    const items = await extensions().listAll<DeliverySpec>(deliveryModel, {
      ...(partnerId ? { where: { partnerId: { eq: partnerId } } } : {}),
      orderBy: { field: 'createdAt', desc: true },
    });
    return items.slice(0, take).map(mapDelivery);
  }

  async listDeliveriesPaged(
    partnerId: string | undefined,
    page: number,
    pageSize: number,
    status?: string,
  ): Promise<{ items: DeliveryRecord[]; total: number }> {
    const result = await extensions().list<DeliverySpec>(deliveryModel, {
      where: {
        ...(partnerId ? { partnerId: { eq: partnerId } } : {}),
        ...(status ? { state: { eq: status } } : {}),
      },
      orderBy: { field: 'createdAt', desc: true },
      page,
      pageSize,
    });
    return { items: result.items.map(mapDelivery), total: result.total };
  }

  /** Atomically claim a due delivery for one runner (PENDING -> DELIVERING). */
  async claimDelivery(id: string): Promise<boolean> {
    const { updated } = await extensions().updateWhere(
      deliveryModel,
      { name: { eq: id }, state: { eq: 'PENDING' } },
      { state: { set: 'DELIVERING' }, attempts: { inc: 1 } },
    );
    return updated > 0;
  }

  async dueDeliveries(now = new Date(), take = 20): Promise<DeliveryRecord[]> {
    const items = await extensions().listAll<DeliverySpec>(deliveryModel, {
      where: {
        state: { eq: 'PENDING' },
        nextAttemptAt: { lte: now.getTime() },
      },
      orderBy: { field: 'createdAt', desc: false },
    });
    return items.slice(0, take).map(mapDelivery);
  }

  async markDelivered(id: string, responseCode: number | null): Promise<void> {
    await this.patch(id, {
      state: 'SUCCEEDED',
      responseCode,
      error: null,
      deliveredAt: new Date().toISOString(),
      nextAttemptAt: 0,
    });
  }

  async markRetry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.patch(id, {
      state: 'PENDING',
      error,
      nextAttemptAt: nextAttemptAt.getTime(),
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.patch(id, {
      state: 'FAILED',
      error,
      nextAttemptAt: 0,
    });
  }

  private async patch(id: string, patch: Partial<DeliverySpec>): Promise<void> {
    const existing = await extensions()
      .get<DeliverySpec>(deliveryModel, id)
      .catch(() => null);
    if (!existing) return;
    await extensions()
      .update<DeliverySpec>(deliveryModel, id, { ...existing.spec, ...patch })
      .catch(() => undefined);
  }
}
