import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

describe.skipIf(!dbAvailable)('plugin nav + my orders integration (real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `nav_admin_${Date.now()}@example.com`;
  const userEmail = `nav_user_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  let productId = '';
  const userIds: string[] = [];

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    userIds.push(admin.userId, user.userId);
    adminToken = admin.token;
    userToken = user.token;
    await prisma.plugin.deleteMany({ where: { id: 'store' } });

    const enable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);

    const create = await app.inject({
      method: 'POST',
      url: '/store/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Nav VPS', price: 5000, stock: 10 },
    });
    productId = (create.json() as { product: { id: string } }).product.id;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    const orders = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "ext_store_order" WHERE "f_userId" = ANY($1::text[])`,
      [...userIds],
    );
    if (orders.length > 0) {
      await prisma.payment.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ext_store_order" WHERE "f_userId" = ANY($1::text[])`,
      [...userIds],
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_store_cart-item" WHERE "spec"->>'userId' = ANY($1::text[])`, [...userIds]);
    await prisma.walletLedgerEntry.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.walletAccount.deleteMany({ where: { userId: { in: userIds } } });
    if (productId) {
      await prisma.$executeRawUnsafe(`DELETE FROM "ext_store_product" WHERE "id" = $1`, productId);
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  it('exposes Store navigation publicly while protecting account navigation', async () => {
    const publicRes = await app.inject({ method: 'GET', url: '/nav/public' });
    expect(publicRes.statusCode).toBe(200);
    expect((publicRes.json() as { items: Array<{ label: string; href: string }> }).items).toEqual([
      { surface: 'public', label: '选购', href: '/shop' },
    ]);

    const accountRes = await app.inject({ method: 'GET', url: '/nav/account' });
    expect(accountRes.statusCode).toBe(401);
  });

  it('returns the independent account-center navigation for a signed-in user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nav/account',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ label: string; href: string }> };
    const labels = body.items.map((i) => i.label);
    expect(labels).toContain('账户概览');
    expect(labels).toContain('账户安全');
    expect(labels).not.toContain('我的订单');
  });

  it('returns 403 for a non-admin requesting the admin nav', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nav/admin',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('keeps Store admin navigation out of the platform nav', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nav/admin',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ label: string; href: string }> };
    const labels = body.items.map((i) => i.label);
    expect(labels).toContain('用户管理');
    expect(labels).not.toContain('Store Products');
    expect(labels).not.toContain('Store Orders');
  });

  it('only exposes Store-owned mutation targets to an authenticated session', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/plugins/store/action-targets' });
    expect(anonymous.statusCode).toBe(401);

    const res = await app.inject({
      method: 'GET',
      url: '/plugins/store/action-targets',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const routes = (res.json() as { routes: Array<{ method: string; path: string }> }).routes;
    expect(routes).toContainEqual({ method: 'POST', path: '/orders', permission: 'store.buy' });
    expect(routes).not.toContainEqual(expect.objectContaining({ path: '/logout' }));
  });

  it('lets a user place an order and lists only their own orders', async () => {
    await app.wallet.adjust({
      userId: userIds[1] as string,
      amount: 5000,
      currency: 'CNY',
      note: 'navigation test credit',
    });
    const create = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { productId, quantity: 1, paymentMode: 'wallet' },
    });
    expect(create.statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: '/orders',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { orders: Array<{ userId: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.orders[0]?.userId).toBeTruthy();
  });

  it('does not leak admin order totals to a user via /orders', async () => {
    const adminOrders = await app.inject({
      method: 'GET',
      url: '/store/admin/orders',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminOrders.statusCode).toBe(200);
    const userOrders = await app.inject({
      method: 'GET',
      url: '/orders',
      headers: { authorization: `Bearer ${userToken}` },
    });
    const userBody = userOrders.json() as { total: number };
    expect(userBody.total).toBe(1);
  });
});
