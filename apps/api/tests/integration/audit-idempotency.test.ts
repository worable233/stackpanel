import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * Regression: plugin replies are captured before sending and cached per
 * caller, method and path.
 */
describe.skipIf(!dbAvailable)('regression: idempotency contract', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const adminEmail = `audit_idem_admin_${suffix}@example.com`;
  const userEmail = `audit_idem_user_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let adminSession = '';
  let userId = '';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(app, adminEmail, password);
    adminSession = admin.token;
    const user = await createTestUser(app, userEmail, password);
    userId = user.userId;

    const prisma = getPrisma();
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    const enable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminSession}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);

    const token = await app.inject({
      method: 'POST',
      url: '/me/api-tokens',
      headers: { authorization: `Bearer ${adminSession}` },
      payload: { name: `audit-idem-${suffix}`, scopes: ['store.admin', 'user:write', 'platform.admin'], ipAllowlist: [] },
    });
    expect(token.statusCode).toBe(200);
    adminToken = (token.json() as { token: string }).token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.apiTokenUsage.deleteMany({ where: { userId: { in: [userId] } } });
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_store_product" WHERE "spec"->>'name' LIKE $1`, `audit-idem-%`);
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await prisma.apiToken.deleteMany({ where: { user: { email: adminEmail } } });
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('memoises a plugin capability that replies directly', async () => {
    const key = randomUUID();
    const payload = { name: `audit-idem-plugin-${suffix}`, price: 100, currency: 'CNY', stock: 1 };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/store/admin/products',
      headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/store/admin/products',
      headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
      payload,
    });
    const rows = await getPrisma().$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "ext_store_product" WHERE "spec"->>'name' = $1`,
      payload.name,
    );
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(rows).toHaveLength(1);
  });

  it('does not replay a cached response across different endpoints', async () => {
    const key = randomUUID();
    const token = adminToken;

    const adjust = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/wallet`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
      payload: { amount: 500, note: 'audit-idem-cross' },
    });
    const gift = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/services`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
      payload: { productId: 'does-not-exist', quantity: 1 },
    });

    expect(adjust.statusCode).toBe(200);
    expect(gift.statusCode).toBe(404);
    expect(gift.headers['idempotency-replayed']).toBeUndefined();
    expect(gift.body).not.toBe(adjust.body);
  });
});
