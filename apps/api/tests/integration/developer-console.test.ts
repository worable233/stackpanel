import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';
import { generateEd25519KeyPair, protectPrivateKey } from '../../src/reseller/keys.ts';
import { ResellerRepository } from '../../src/reseller/repository.ts';
import { bodyDigest, canonicalRequest, signCanonical } from '../../src/reseller/signing.ts';

const dbAvailable = await checkDbAvailable();

/**
 * Developer console (P4 / DEV-CONSOLE): read-only distribution views over the
 * kernel-owned reseller, webhook-delivery and SP v1 call-audit data. Verifies
 * admin-only access, secret redaction, filtering and the onResponse audit hook.
 */
describe.skipIf(!dbAvailable)('developer console (real DB)', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  let adminToken = '';
  let adminEmail = '';
  let userToken = '';
  let userEmail = '';
  let resellerId = '';
  let resellerKeyId = '';
  const inbound = generateEd25519KeyPair();
  const webhook = generateEd25519KeyPair();

  const auth = () => ({ authorization: `Bearer ${adminToken}` });

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const repo = new ResellerRepository(prisma);

    adminEmail = `dev-admin-${suffix}@example.com`;
    adminToken = (await createAdminUser(app, adminEmail, 'password1234')).token;
    userEmail = `dev-user-${suffix}@example.com`;
    userToken = (await createTestUser(app, userEmail, 'password1234')).token;

    resellerKeyId = `dev_reseller_${suffix}`;
    const created = await repo.create({
      id: `res_${suffix}_dev`,
      name: `dev-reseller-${suffix}`,
      keyId: resellerKeyId,
      publicKey: inbound.publicKey,
      webhookPrivateKey: protectPrivateKey(webhook.privateKey),
      webhookPublicKey: webhook.publicKey,
      webhookUrl: 'https://partner.example.com/hook',
      scopes: ['catalog:read'],
      rateLimitRpm: 120,
    });
    resellerId = created.id;
    await repo.createDelivery({
      id: `wh_${suffix}_pending`,
      resellerId,
      event: 'order.paid',
      url: 'https://partner.example.com/hook',
      payload: { id: `wh_${suffix}_pending`, event: 'order.paid', data: {} },
      maxAttempts: 3,
    });
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.webhookDelivery.deleteMany({ where: { resellerId } });
    await new ResellerRepository(prisma).delete(resellerId).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { action: 'sp_v1.call', resourceId: resellerId } });
    if (adminEmail) await prisma.user.deleteMany({ where: { email: adminEmail } });
    if (userEmail) await prisma.user.deleteMany({ where: { email: userEmail } });
    await app.close();
  });

  it('rejects a non-admin caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/developer/overview',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns the distribution overview', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/developer/overview',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      overview: {
        resellers: { total: number; active: number };
        webhookDeliveries: { pending: number; failed: number; succeeded: number };
        calls: { last24h: number; total: number };
      };
    };
    expect(body.overview.resellers.total).toBeGreaterThanOrEqual(1);
    expect(body.overview.resellers.active).toBeGreaterThanOrEqual(1);
    expect(body.overview.webhookDeliveries.pending).toBeGreaterThanOrEqual(1);
  });

  it('lists resellers without leaking private keys', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/developer/resellers?pageSize=100',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { resellers: Array<Record<string, unknown>>; total: number };
    const row = body.resellers.find((entry) => entry.id === resellerId);
    expect(row).toBeDefined();
    expect(row?.hasWebhookKey).toBe(true);
    expect(row?.publicKey).toBe(inbound.publicKey);
    expect(row).not.toHaveProperty('webhookPrivateKey');
    expect(JSON.stringify(body)).not.toContain(webhook.privateKey);
  });

  it('returns reseller detail with recent deliveries (no secrets)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/developer/resellers/${resellerId}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reseller: { id: string; hasWebhookKey: boolean };
      deliveries: Array<{ event: string; resellerName: string | null }>;
    };
    expect(body.reseller.id).toBe(resellerId);
    expect(body.deliveries.some((delivery) => delivery.event === 'order.paid')).toBe(true);
    expect(JSON.stringify(body)).not.toContain(webhook.privateKey);
  });

  it('404s an unknown reseller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/developer/resellers/does-not-exist',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists webhook deliveries with the partner name and filters by status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/developer/webhook-deliveries?resellerId=${resellerId}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deliveries: Array<{ resellerName: string | null; resellerId: string }>;
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.deliveries[0]?.resellerName).toBe(`dev-reseller-${suffix}`);

    const succeeded = await app.inject({
      method: 'GET',
      url: `/admin/developer/webhook-deliveries?status=SUCCEEDED&resellerId=${resellerId}`,
      headers: auth(),
    });
    expect((succeeded.json() as { total: number }).total).toBe(0);
  });

  it('records SP v1 calls in the audit trail and filters by reseller', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = `devconsole-${suffix}`;
    const canonical = canonicalRequest({
      method: 'GET',
      path: '/sp/v1/catalog',
      timestamp,
      nonce,
      bodyDigest: bodyDigest(''),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/sp/v1/catalog',
      headers: {
        'x-sp-key-id': resellerKeyId,
        'x-sp-timestamp': timestamp,
        'x-sp-nonce': nonce,
        'x-sp-signature': signCanonical(canonical, inbound.privateKey),
      },
    });
    // The catalog may degrade when the store plugin is inactive; the audit
    // entry is written regardless of the business outcome.
    expect(res.statusCode).toBeLessThan(600);

    let total = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const list = await app.inject({
        method: 'GET',
        url: `/admin/developer/calls?resellerId=${resellerId}`,
        headers: auth(),
      });
      expect(list.statusCode).toBe(200);
      total = (list.json() as { total: number }).total;
      if (total >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(total).toBeGreaterThanOrEqual(1);

    const list = await app.inject({
      method: 'GET',
      url: `/admin/developer/calls?resellerId=${resellerId}`,
      headers: auth(),
    });
    const logs = (
      list.json() as {
        logs: Array<{ action: string; resourceId: string | null; meta: { method?: string } }>;
      }
    ).logs;
    const entry = logs[0];
    expect(entry?.action).toBe('sp_v1.call');
    expect(entry?.resourceId).toBe(resellerId);
    expect(entry?.meta?.method).toBe('GET');
  });
});
