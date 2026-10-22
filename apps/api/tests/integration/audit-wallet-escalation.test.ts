import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * Regression: a delegated user-manager may hold `user:write`, but that scope
 * must never authorize platform money movement or paid-service fulfilment.
 */
describe.skipIf(!dbAvailable)('regression: user:write cannot create value', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const adminEmail = `audit_admin_${suffix}@example.com`;
  const managerEmail = `audit_manager_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let managerId = '';
  let managerSession = '';
  let groupId = '';
  let adminSession = '';
  let productId = '';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const admin = await createAdminUser(app, adminEmail, password);
    adminSession = admin.token;

    const group = await prisma.permissionGroup.create({ data: { name: `audit-usermgr-${suffix}` } });
    groupId = group.id;
    const manageUsers = await prisma.permission.findUniqueOrThrow({
      where: { key: 'platform.manage.users' },
    });
    await prisma.groupPermission.create({
      data: { groupId: group.id, permissionId: manageUsers.id },
    });

    const manager = await createTestUser(app, managerEmail, password, { groupIds: [group.id] });
    managerId = manager.userId;
    managerSession = manager.token;

    // A paid product the delegated manager will grant to itself.
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    const enable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminSession}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
    const created = await app.inject({
      method: 'POST',
      url: '/store/admin/products',
      headers: { authorization: `Bearer ${adminSession}` },
      payload: { name: `audit-product-${suffix}`, price: 500000, currency: 'CNY', stock: 5 },
    });
    expect(created.statusCode).toBe(201);
    productId = (created.json() as { product: { id: string } }).product.id;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.apiTokenUsage.deleteMany({ where: { userId: managerId } });
    await prisma.apiToken.deleteMany({ where: { userId: managerId } });
    await prisma.walletLedgerEntry.deleteMany({ where: { userId: managerId } });
    await prisma.walletAccount.deleteMany({ where: { userId: managerId } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, managerEmail] } } });
    await prisma.permissionGroup.deleteMany({ where: { id: groupId } });
    await app.close();
  });

  it('rejects a non-admin user-manager credit to its own wallet', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/me/api-tokens/scopes',
      headers: { authorization: `Bearer ${managerSession}` },
    });
    expect(me.statusCode).toBe(200);
    const keys = (me.json() as { scopes: Array<{ key: string }> }).scopes.map((s) => s.key);
    expect(keys).toContain('user:write');

    const created = await app.inject({
      method: 'POST',
      url: '/me/api-tokens',
      headers: { authorization: `Bearer ${managerSession}` },
      payload: { name: 'audit-escalation', scopes: ['user:write'], ipAllowlist: [] },
    });
    expect(created.statusCode).toBe(200);
    const token = (created.json() as { token: string }).token;

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/balance',
      headers: { authorization: `Bearer ${token}` },
    });
    const balanceBefore = before.statusCode === 200
      ? (before.json() as { account: { balance: number } }).account.balance
      : 0;

    const credit = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${managerId}/wallet`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: { amount: 999999, note: 'audit-escalation' },
    });

    const ledger = await getPrisma().walletLedgerEntry.findMany({
      where: { userId: managerId, note: 'audit-escalation' },
    });
    expect(credit.statusCode).toBe(403);
    expect(ledger).toHaveLength(0);
    expect(balanceBefore).toBe(0);
  });

  it('rejects the same non-admin user-manager granting itself a paid service', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/me/api-tokens',
      headers: { authorization: `Bearer ${managerSession}` },
      payload: { name: 'audit-escalation-svc', scopes: ['user:write'], ipAllowlist: [] },
    });
    expect(created.statusCode).toBe(200);
    const token = (created.json() as { token: string }).token;

    const gift = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${managerId}/services`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: { productId, quantity: 1 },
    });

    const services = await getPrisma().$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "ext_store_service-instance" WHERE "spec"->>'userId' = $1`,
      managerId,
    );
    expect(gift.statusCode).toBe(403);
    expect(services).toHaveLength(0);
  });
});
