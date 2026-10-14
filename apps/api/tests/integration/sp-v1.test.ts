import type { FastifyInstance } from 'fastify';
import type { CommerceOperations } from '@stackpanel/sdk';
import { generateKeyPairSync } from 'node:crypto';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser } from '../auth-helpers.ts';
import { bodyDigest, canonicalRequest, signCanonical } from '../sp-signing.ts';
import { deletePartner, enablePlugin, seedPartner } from '../channel-helpers.ts';

const dbAvailable = await checkDbAvailable();

const PRODUCT_TABLE = 'ext_store_product';
const SERVICE_TABLE = 'ext_store_service-instance';

/** A fresh Ed25519 key pair in PEM (test-local; avoids importing plugin code). */
function generateEd25519KeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

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
 * SP v1 upstream surface (ADR-0021 §D4, now served by the channel plugin):
 * partner Ed25519 signing, nonce replay defense, scope enforcement, idempotent
 * writes and signed webhook delivery.
 */
describe.skipIf(!dbAvailable)('SP v1 channel surface (real DB)', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const keyId = `it_partner_${suffix}`;
  const aliceKey = generateEd25519KeyPair(); // full-scope partner
  const bobKey = generateEd25519KeyPair(); // read-only partner
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

    adminEmail = `sp-admin-${suffix}@example.com`;
    adminToken = (await createAdminUser(app, adminEmail, 'password1234')).token;
    // SP v1 reads/writes through the store plugin's commerce outlet.
    await enablePlugin(app, 'store', adminToken);
    await enablePlugin(app, 'channel', adminToken);

    aliceId = `res_${suffix}_a`;
    await seedPartner({
      id: aliceId,
      name: `it-partner-a-${suffix}`,
      keyId: `${keyId}_a`,
      publicKey: aliceKey.publicKey,
      scopes: ['catalog:read', 'order:read', 'order:write', 'service:read', 'service:write'],
      rateLimitRpm: 0,
    });
    bobId = `res_${suffix}_b`;
    await seedPartner({
      id: bobId,
      name: `it-partner-b-${suffix}`,
      keyId: `${keyId}_b`,
      publicKey: bobKey.publicKey,
      scopes: ['catalog:read'],
      rateLimitRpm: 0,
    });

    productId = `sp_prod_${suffix}`;
    await seedProduct(productId, `SP-V1 测试商品 ${suffix}`, 1200, 5);
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await deletePartner(aliceId);
    await deletePartner(bobId);
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ext_store_order" WHERE "spec"->>'channelCode' LIKE 'SP_V1:%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "${SERVICE_TABLE}" WHERE "f_productId" = $1`,
      productId,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "${PRODUCT_TABLE}" WHERE "id" = $1`, productId);
    await prisma.plugin.deleteMany({ where: { id: { in: ['store', 'channel'] } } });
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

  it('enforces scopes per partner', async () => {
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

});
