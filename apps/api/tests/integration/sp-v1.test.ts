import type { FastifyInstance } from 'fastify';
import type { CommerceOperations } from '@stackpanel/sdk';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser } from '../auth-helpers.ts';
import { generateEd25519KeyPair, protectPrivateKey } from '../../src/reseller/keys.ts';
import { ResellerRepository } from '../../src/reseller/repository.ts';
import {
  canonicalRequest,
  bodyDigest,
  signCanonical,
  verifyRequestSignature,
} from '../../src/reseller/signing.ts';
import { processDueWebhooks } from '../../src/reseller/webhook.ts';

const dbAvailable = await checkDbAvailable();

const PRODUCT_TABLE = 'ext_store_product';
const SERVICE_TABLE = 'ext_store_service-instance';

/** Seed an active product in the store plugin's Extension table. */
async function seedProduct(id: string, name: string, price: number, stock: number): Promise<void> {
  const spec = {
    name,
    description: null,
    price,
    currency: 'CNY',
    cost: null,
    originalPrice: null,
    discount: null,
    stock,
    status: 'ACTIVE',
    metadata: null,
    categoryId: null,
    fulfillmentType: 'manual',
    providerId: null,
    providerProductId: null,
  };
  await getPrisma().$executeRawUnsafe(
    `INSERT INTO "${PRODUCT_TABLE}"
       ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
        "created_at", "updated_at", "f_status", "f_stock", "f_categoryId", "f_providerId")
     VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
             now(), now(), 'ACTIVE', $3, NULL, NULL)`,
    id,
    JSON.stringify(spec),
    stock,
  );
}

/**
 * SP v1 upstream surface (P3): reseller Ed25519 signing, nonce replay defense,
 * scope enforcement, idempotent writes and signed webhook delivery.
 */
describe.skipIf(!dbAvailable)('SP v1 reseller surface (real DB)', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const keyId = `it_reseller_${suffix}`;
  const aliceKey = generateEd25519KeyPair(); // full-scope reseller
  const bobKey = generateEd25519KeyPair(); // read-only reseller
  let aliceId = '';
  let bobId = '';
  let adminEmail = '';
  let adminToken = '';
  let productId = '';
  let nonceCounter = 0;

  /** Build a signed header set for one request. */
  function signedHeaders(input: {
    keyId: string;
    privateKey: string;
    method: string;
    url: string;
    body?: string;
    timestamp?: number;
    nonce?: string;
  }): Record<string, string> {
    const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
    const nonce = input.nonce ?? `nonce-${suffix}-${(nonceCounter += 1)}`;
    const canonical = canonicalRequest({
      method: input.method,
      path: input.url,
      timestamp,
      nonce,
      bodyDigest: bodyDigest(input.body),
    });
    return {
      'x-sp-key-id': input.keyId,
      'x-sp-timestamp': timestamp,
      'x-sp-nonce': nonce,
      'x-sp-signature': signCanonical(canonical, input.privateKey),
    };
  }

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const repo = new ResellerRepository(prisma);

    const alice = await repo.create({
      id: `res_${suffix}_a`,
      name: `it-reseller-a-${suffix}`,
      keyId: `${keyId}_a`,
      publicKey: aliceKey.publicKey,
      scopes: ['catalog:read', 'order:read', 'order:write', 'service:read', 'service:write'],
      rateLimitRpm: 0,
    });
    aliceId = alice.id;

    const bob = await repo.create({
      id: `res_${suffix}_b`,
      name: `it-reseller-b-${suffix}`,
      keyId: `${keyId}_b`,
      publicKey: bobKey.publicKey,
      scopes: ['catalog:read'],
      rateLimitRpm: 0,
    });
    bobId = bob.id;

    // SP v1 now reads/writes through the store plugin's commerce outlet.
    adminEmail = `sp-admin-${suffix}@example.com`;
    const admin = await createAdminUser(app, adminEmail, 'password1234');
    adminToken = admin.token;
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    const enable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);

    productId = `sp_prod_${suffix}`;
    await seedProduct(productId, `SP-V1 测试商品 ${suffix}`, 1200, 5);
  });

  afterAll(async () => {
    const prisma = getPrisma();
    const repo = new ResellerRepository(prisma);
    await repo.delete(aliceId);
    await repo.delete(bobId);
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ext_store_order" WHERE "spec"->>'channelCode' LIKE 'SP_V1:%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "${SERVICE_TABLE}" WHERE "f_productId" = $1`,
      productId,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "${PRODUCT_TABLE}" WHERE "id" = $1`, productId);
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    await prisma.user.deleteMany({ where: { email: { contains: 'reseller+' } } });
    if (adminEmail) await prisma.user.deleteMany({ where: { email: adminEmail } });
    await app.close();
  });

  it('rejects a request without signature headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/sp/v1/catalog' });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe('sp_v1.signature_missing');
  });

  it('rejects a signature from an unknown key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sp/v1/catalog',
      headers: signedHeaders({
        keyId: 'does_not_exist',
        privateKey: aliceKey.privateKey,
        method: 'GET',
        url: '/sp/v1/catalog',
      }),
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe('sp_v1.key_unknown');
  });

  it('rejects an expired timestamp', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sp/v1/catalog',
      headers: signedHeaders({
        keyId: `${keyId}_a`,
        privateKey: aliceKey.privateKey,
        method: 'GET',
        url: '/sp/v1/catalog',
        timestamp: Math.floor(Date.now() / 1000) - 3600,
      }),
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe('sp_v1.signature_expired');
  });

  it('serves the catalog to a correctly signed request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sp/v1/catalog?pageSize=50',
      headers: signedHeaders({
        keyId: `${keyId}_a`,
        privateKey: aliceKey.privateKey,
        method: 'GET',
        url: '/sp/v1/catalog?pageSize=50',
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.some((item) => item.id === productId)).toBe(true);
  });

  it('rejects a replayed nonce', async () => {
    const headers = signedHeaders({
      keyId: `${keyId}_a`,
      privateKey: aliceKey.privateKey,
      method: 'GET',
      url: '/sp/v1/catalog',
      nonce: `replay-${suffix}`,
    });
    const first = await app.inject({ method: 'GET', url: '/sp/v1/catalog', headers });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'GET', url: '/sp/v1/catalog', headers });
    expect(second.statusCode).toBe(401);
    expect((second.json() as { code: string }).code).toBe('sp_v1.nonce_replayed');
  });

  it('enforces scopes per reseller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sp/v1/orders',
      headers: signedHeaders({
        keyId: `${keyId}_b`,
        privateKey: bobKey.privateKey,
        method: 'GET',
        url: '/sp/v1/orders',
      }),
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('sp_v1.scope_forbidden');
  });

  it('requires an Idempotency-Key on order writes', async () => {
    const body = JSON.stringify({ productId, quantity: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/sp/v1/orders',
      headers: {
        'content-type': 'application/json',
        ...signedHeaders({
          keyId: `${keyId}_a`,
          privateKey: aliceKey.privateKey,
          method: 'POST',
          url: '/sp/v1/orders',
          body,
        }),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('request.idempotency_key_required');
  });

  it('creates an order once and replays the same response for a repeated key', async () => {
    const body = JSON.stringify({ productId, quantity: 2, channelCode: 'ch-1' });
    const idempotencyKey = `spv1-idem-${suffix}-order`;
    const sign = (nonce: string) =>
      signedHeaders({
        keyId: `${keyId}_a`,
        privateKey: aliceKey.privateKey,
        method: 'POST',
        url: '/sp/v1/orders',
        body,
        nonce,
      });
    // Each request carries a fresh nonce (nonces are single-use); the
    // Idempotency-Key is what makes the retry replay-safe.
    const first = await app.inject({
      method: 'POST',
      url: '/sp/v1/orders',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        ...sign(`order-a-${suffix}`),
      },
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    const firstOrder = (first.json() as { order: { id: string; total: number } }).order;
    expect(firstOrder.total).toBe(2400);

    const second = await app.inject({
      method: 'POST',
      url: '/sp/v1/orders',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        ...sign(`order-b-${suffix}`),
      },
      payload: body,
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());

    // Stock decremented exactly once (5 - 2).
    const rows = await getPrisma().$queryRawUnsafe<Array<{ f_stock: number }>>(
      `SELECT "f_stock" FROM "${PRODUCT_TABLE}" WHERE "id" = $1`,
      productId,
    );
    expect(rows[0]?.f_stock).toBe(3);
  });

  it('transitions a service lifecycle and records the status', async () => {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({
      where: { email: `reseller+${`${keyId}_a`.toLowerCase()}@reseller.stackpanel.local` },
    });
    if (!user) throw new Error('预置：渠道系统用户未创建');
    const commerce = app.pluginRuntime.getExtensions<CommerceOperations>(
      EXTENSION_POINTS.commerce,
    )[0];
    if (!commerce) throw new Error('预置：commerce 出口未注册');
    const [service] = await commerce.createServices({ userId: user.id, productId, quantity: 1 });
    if (!service) throw new Error('预置：交付物未创建');
    const url = `/sp/v1/services/${service.id}/suspend`;
    const body = '{}';
    const res = await app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `spv1-idem-${suffix}-suspend`,
        ...signedHeaders({
          keyId: `${keyId}_a`,
          privateKey: aliceKey.privateKey,
          method: 'POST',
          url,
          body,
          nonce: `suspend-${suffix}`,
        }),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const updated = await commerce.getService(user.id, service.id);
    expect(updated?.status).toBe('SUSPENDED');
  });

  it('delivers a signed webhook, retries with backoff, then verifies the signature', async () => {
    const prisma = getPrisma();
    const repo = new ResellerRepository(prisma);
    const webhookKeys = generateEd25519KeyPair();
    // 回调地址用公网 IP 字面量：SSRF 守卫对字面量直接判定、不做 DNS，测试因此
    // 不依赖外部解析器（否则并发受压时会卡在 libuv 解析线程池上导致超时）。
    const webhookUrl = 'https://93.184.216.34/sp-hook';
    await repo.update(aliceId, {
      webhookUrl,
      webhookPrivateKey: protectPrivateKey(webhookKeys.privateKey),
      webhookPublicKey: webhookKeys.publicKey,
    });
    const delivery = await repo.createDelivery({
      id: `wh_${suffix}`,
      resellerId: aliceId,
      event: 'order.paid',
      url: webhookUrl,
      payload: { id: `wh_${suffix}`, event: 'order.paid', data: { orderId: 'o_1' } },
      maxAttempts: 3,
    });

    // Attempt 1: transport failure → scheduled retry with a future nextAttemptAt.
    const failing = (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch;
    const claimed = await processDueWebhooks(prisma, failing);
    expect(claimed).toBe(1);
    let row = await repo.findDelivery(delivery.id);
    expect(row?.status).toBe('PENDING');
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt?.getTime() ?? 0).toBeGreaterThan(Date.now());

    // Force the retry due, then deliver successfully and capture the request.
    // Set the deadline in the *past* rather than to CURRENT_TIMESTAMP: the
    // dispatcher compares against the application clock, and a database clock
    // even a few milliseconds ahead would otherwise leave the row not-yet-due.
    await prisma.$executeRaw`
      UPDATE "webhook_deliveries" SET "nextAttemptAt" = now() - interval '60 seconds'
      WHERE "id" = ${delivery.id}
    `;
    let captured: Array<{ headers: Record<string, string>; body: string; url: string }> = [];
    const okFetch = ((url: string, init: RequestInit) => {
      captured = [
        ...captured,
        {
          url,
          headers: init.headers as Record<string, string>,
          body: String(init.body),
        },
      ];
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;
    const claimedAgain = await processDueWebhooks(prisma, okFetch);
    expect(claimedAgain).toBe(1);
    row = await repo.findDelivery(delivery.id);
    expect(row?.status).toBe('SUCCEEDED');
    expect(row?.responseCode).toBe(200);

    expect(captured).toHaveLength(1);
    const request = captured[0];
    if (!request) throw new Error('预置：webhook 回调未被捕获');
    // The outbound signature verifies against the reseller webhook public key.
    const verdict = verifyRequestSignature(
      {
        method: 'POST',
        path: '/sp-hook',
        timestamp: request.headers['x-sp-timestamp'] ?? '',
        nonce: request.headers['x-sp-delivery'] ?? '',
        signature: request.headers['x-sp-signature'] ?? '',
        body: request.body,
      },
      webhookKeys.publicKey,
    );
    expect(verdict).toEqual({ ok: true });
    expect(request.headers['x-sp-key-id']).toBe(`${keyId}_a`);
    expect(request.headers['x-sp-event']).toBe('order.paid');
  });
});
