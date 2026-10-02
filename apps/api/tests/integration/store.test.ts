import type { FastifyInstance } from 'fastify';
import type { PaymentProvider } from '@stackpanel/sdk';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { getEventBus } from '../../src/plugins/events.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * 商店数据已迁到 Extension 引擎物理表（ADR-0008）。集成测试直接读写这些
 * 物理表来播种/断言（内核 `payment` / `wallet` / `salesChannel` /
 * `payment_method` 仍是内核域，继续走 Prisma）。
 */

const PRODUCT_TABLE = 'ext_store_product';
const ORDER_TABLE = 'ext_store_order';
const CART_TABLE = 'ext_store_cart-item';

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function seedProduct(input: {
  id?: string;
  name: string;
  price: number;
  currency?: string;
  stock: number;
  status?: string;
  providerId?: string | null;
  fulfillmentType?: string;
  metadata?: unknown;
  providerProductId?: string | null;
}): Promise<string> {
  const id = input.id ?? newId('prod');
  const status = input.status ?? 'ACTIVE';
  const spec = {
    name: input.name,
    description: null,
    price: input.price,
    currency: input.currency ?? 'CNY',
    cost: null,
    originalPrice: null,
    discount: null,
    stock: input.stock,
    status,
    metadata: input.metadata ?? null,
    categoryId: null,
    fulfillmentType: input.fulfillmentType ?? 'instant',
    providerId: input.providerId ?? null,
    providerProductId: input.providerProductId ?? null,
  };
  await getPrisma().$executeRawUnsafe(
    `INSERT INTO "${PRODUCT_TABLE}"
       ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
        "created_at", "updated_at", "f_status", "f_stock", "f_categoryId", "f_providerId")
     VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
             now(), now(), $3, $4, NULL, $5)`,
    id,
    JSON.stringify(spec),
    status,
    input.stock,
    input.providerId ?? null,
  );
  return id;
}

async function seedOrder(input: {
  id?: string;
  userId: string;
  items: unknown;
  total: number;
  currency?: string;
  state?: string;
  channelCode?: string | null;
  settlementCurrency?: string;
  settlementTotal: number;
  fxRate?: number | null;
}): Promise<string> {
  const id = input.id ?? newId('order');
  const state = input.state ?? 'PENDING';
  const spec = {
    userId: input.userId,
    items: input.items,
    total: input.total,
    currency: input.currency ?? 'CNY',
    state,
    channelCode: input.channelCode ?? null,
    settlementCurrency: input.settlementCurrency ?? 'CNY',
    settlementTotal: input.settlementTotal,
    fxRate: input.fxRate ?? null,
  };
  await getPrisma().$executeRawUnsafe(
    `INSERT INTO "${ORDER_TABLE}"
       ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
        "created_at", "updated_at", "f_userId", "f_state")
     VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
             now(), now(), $3, $4)`,
    id,
    JSON.stringify(spec),
    input.userId,
    state,
  );
  return id;
}

async function readProductStock(id: string): Promise<number> {
  const rows = await getPrisma().$queryRawUnsafe<Array<{ f_stock: number | null }>>(
    `SELECT "f_stock" FROM "${PRODUCT_TABLE}" WHERE "id" = $1`,
    id,
  );
  return rows[0]?.f_stock ?? -1;
}

async function readOrderState(id: string): Promise<string | null> {
  const rows = await getPrisma().$queryRawUnsafe<Array<{ f_state: string | null }>>(
    `SELECT "f_state" FROM "${ORDER_TABLE}" WHERE "id" = $1`,
    id,
  );
  return rows[0]?.f_state ?? null;
}

async function deleteStoreOrder(id: string): Promise<void> {
  await getPrisma().$executeRawUnsafe(`DELETE FROM "${ORDER_TABLE}" WHERE "id" = $1`, id);
}

async function deleteStoreProduct(id: string): Promise<void> {
  await getPrisma().$executeRawUnsafe(`DELETE FROM "${PRODUCT_TABLE}" WHERE "id" = $1`, id);
}

describe.skipIf(!dbAvailable)('store plugin wallet and settlement integration (real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `it_admin_${Date.now()}@example.com`;
  const userEmail = `it_user_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  let userId = '';
  let productId = '';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    adminToken = admin.token;
    userToken = user.token;
    userId = user.userId;
    await prisma.plugin.deleteMany({ where: { id: 'store' } });

    const enable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.$executeRawUnsafe(`DELETE FROM "${CART_TABLE}" WHERE "spec"->>'userId' = $1`, userId);
    await prisma.$executeRawUnsafe(`DELETE FROM "${ORDER_TABLE}" WHERE "spec"->>'userId' = $1`, userId);
    if (productId) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${PRODUCT_TABLE}" WHERE "id" = $1`, productId);
    }
    await prisma.payment.deleteMany({ where: { userId } });
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('lets anyone browse products but requires auth to order', async () => {
    expect((await app.inject({ method: 'GET', url: '/products' })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/orders',
          payload: { productId: 'x', quantity: 1 },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('lets an admin create a product', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'VPS-1C', price: 9900, stock: 5, description: '1 vCPU / 1GB RAM' },
    });
    expect(res.statusCode).toBe(201);
    productId = (res.json() as { product: { id: string } }).product.id;
    expect(await readProductStock(productId)).toBe(5);
  });

  it('allows creating products in a foreign currency (multi-currency pricing)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'USD Product', price: 10000, stock: 1, currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { product: { currency: string } }).product.currency).toBe('USD');
  });

  it('rejects wallet payment without balance and preserves stock', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { productId, quantity: 1, paymentMode: 'wallet' },
    });
    expect(res.statusCode).toBe(409);
    expect(await readProductStock(productId)).toBe(5);
  });

  it('settles wallet payment atomically and prevents an overspend race', async () => {
    await app.wallet.adjust({
      userId,
      amount: 9900,
      currency: 'CNY',
      note: 'store integration credit',
    });
    const [left, right] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { productId, quantity: 1, paymentMode: 'wallet' },
      }),
      app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { productId, quantity: 1, paymentMode: 'wallet' },
      }),
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
    const paid = (left.statusCode === 200 ? left : right).json() as {
      order: { id: string; status: string };
    };
    expect(paid.order.status).toBe('PAID');
    const wallet = await getPrisma().walletAccount.findUniqueOrThrow({
      where: { userId_currency: { userId, currency: 'CNY' } },
    });
    expect(wallet.balance).toBe(0);
    expect(await readProductStock(productId)).toBe(4);
    expect(
      await getPrisma().walletLedgerEntry.count({ where: { userId, type: 'ORDER_PAYMENT' } }),
    ).toBe(1);
  });

  it('requires auth to add items to or list the cart', async () => {
    expect((await app.inject({ method: 'GET', url: '/cart' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/cart/items',
          payload: { productId, quantity: 1 },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('adds items to the cart and lists them for the owner', async () => {
    const add = await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { productId, quantity: 2 },
    });
    expect(add.statusCode).toBe(201);
    const item = (add.json() as { item: { id: string; quantity: number } }).item;
    expect(item.quantity).toBe(2);

    const list = await app.inject({
      method: 'GET',
      url: '/cart',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: Array<{ id: string; quantity: number }>; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(19800);
  });

  it('cannot checkout without wallet balance and keeps the cart intact', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cart/checkout',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { cartItemIds: [await firstCartItemId()], paymentMode: 'wallet' },
    });
    expect(res.statusCode).toBe(409);
    const cart = await app.inject({
      method: 'GET',
      url: '/cart',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect((cart.json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it('checks out selected cart items with wallet and clears them', async () => {
    const itemId = await firstCartItemId();
    await app.wallet.adjust({
      userId,
      amount: 19800,
      currency: 'CNY',
      note: 'cart integration credit',
    });

    const checkout = await app.inject({
      method: 'POST',
      url: '/cart/checkout',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { cartItemIds: [itemId], paymentMode: 'wallet' },
    });
    expect(checkout.statusCode).toBe(200);
    const order = (checkout.json() as { order: { id: string; status: string } }).order;
    expect(order.status).toBe('PAID');

    const cart = await app.inject({
      method: 'GET',
      url: '/cart',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect((cart.json() as { items: unknown[] }).items).toHaveLength(0);
    expect(await readProductStock(productId)).toBe(2);
  });

  async function firstCartItemId(): Promise<string> {
    const res = await app.inject({
      method: 'GET',
      url: '/cart',
      headers: { authorization: `Bearer ${userToken}` },
    });
    const items = (res.json() as { items: Array<{ id: string }> }).items;
    const item = items[0];
    if (!item) throw new Error('Expected a cart item');
    return item.id;
  }

  it('settles a verified external order once even if the callback is repeated', async () => {
    const prisma = getPrisma();
    const orderId = await seedOrder({
      userId,
      items: { items: [] },
      total: 3000,
      currency: 'CNY',
      state: 'PENDING',
      settlementTotal: 3000,
      settlementCurrency: 'CNY',
    });
    await prisma.payment.create({
      data: {
        purpose: 'ORDER',
        userId,
        orderId,
        gateway: 'epay',
        providerId: 'epay',
        paymentMethod: 'alipay',
        merchantOrderNo: `sp_ord_test_${Date.now()}`,
        amount: 3000,
        currency: 'CNY',
        status: 'PENDING',
      },
    });
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId } });
    const settled = {
      providerId: 'epay',
      merchantOrderNo: payment.merchantOrderNo as string,
      externalId: 'trade_123',
      amount: 3000,
      currency: 'CNY',
    };
    expect((await app.payments.settle(settled)).applied).toBe(true);
    expect((await app.payments.settle(settled)).applied).toBe(false);
    expect(await readOrderState(orderId)).toBe('PAID');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'PAID',
    );
    await prisma.payment.deleteMany({ where: { orderId } });
    await deleteStoreOrder(orderId);
  });

  it('cancels an external order via a claimed CANCELLING state and restores stock', async () => {
    const prisma = getPrisma();
    const mockProvider: PaymentProvider = {
      id: 'mockpay',
      name: 'Mock Pay',
      mode: 'gateway',
      callbackPath: '/callbacks/mockpay',
      getMethods: () => [{ id: 'mock', label: 'Mock', topUpAmounts: [1000] }],
      createPayment: async () => ({ externalId: 'ext_cancel_1', paymentUrl: 'https://pay.mock/1' }),
      closePayment: vi.fn(async () => true),
    };
    const unregister = app.pluginRuntime.registerExtension(
      EXTENSION_POINTS.paymentProvider,
      mockProvider,
      'mockpay',
    );

    const product = await seedProduct({ name: 'Cancel-VPS', price: 9900, currency: 'CNY', stock: 3 });
    const orderId = await seedOrder({
      userId,
      items: { items: [{ productId: product, quantity: 2 }] },
      total: 19800,
      currency: 'CNY',
      state: 'PENDING',
      settlementTotal: 19800,
      settlementCurrency: 'CNY',
    });
    const payment = await prisma.payment.create({
      data: {
        purpose: 'ORDER',
        userId,
        orderId,
        gateway: 'mockpay',
        providerId: 'mockpay',
        paymentMethod: 'mock',
        merchantOrderNo: `sp_ord_cancel_${Date.now()}`,
        amount: 19800,
        currency: 'CNY',
        status: 'PENDING',
      },
    });

    const cancel = await app.inject({
      method: 'POST',
      url: `/orders/${orderId}/cancel`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { cancelled: boolean }).cancelled).toBe(true);
    expect(mockProvider.closePayment).toHaveBeenCalledWith(
      expect.objectContaining({ merchantOrderNo: payment.merchantOrderNo }),
    );
    expect(await readOrderState(orderId)).toBe('CANCELLED');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'CANCELLED',
    );
    expect(await readProductStock(product)).toBe(5);

    await prisma.payment.deleteMany({ where: { orderId } });
    await deleteStoreOrder(orderId);
    await deleteStoreProduct(product);
    unregister();
  });

  it('does not leave an order stuck in CANCELLING when the provider close throws', async () => {
    const prisma = getPrisma();
    const mockProvider: PaymentProvider = {
      id: 'mockpay',
      name: 'Mock Pay',
      mode: 'gateway',
      callbackPath: '/callbacks/mockpay',
      getMethods: () => [{ id: 'mock', label: 'Mock', topUpAmounts: [1000] }],
      createPayment: async () => ({
        externalId: 'ext_cancel_err',
        paymentUrl: 'https://pay.mock/x',
      }),
      closePayment: vi.fn(async () => {
        throw new Error('gateway unreachable');
      }),
    };
    const unregister = app.pluginRuntime.registerExtension(
      EXTENSION_POINTS.paymentProvider,
      mockProvider,
      'mockpay',
    );

    const product = await seedProduct({ name: 'Cancel-Err', price: 9900, currency: 'CNY', stock: 3 });
    const orderId = await seedOrder({
      userId,
      items: { items: [{ productId: product, quantity: 1 }] },
      total: 9900,
      currency: 'CNY',
      state: 'PENDING',
      settlementTotal: 9900,
      settlementCurrency: 'CNY',
    });
    const payment = await prisma.payment.create({
      data: {
        purpose: 'ORDER',
        userId,
        orderId,
        gateway: 'mockpay',
        providerId: 'mockpay',
        paymentMethod: 'mock',
        merchantOrderNo: `sp_ord_cancel_err_${Date.now()}`,
        amount: 9900,
        currency: 'CNY',
        status: 'PENDING',
      },
    });

    const cancel = await app.inject({
      method: 'POST',
      url: `/orders/${orderId}/cancel`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(cancel.statusCode).toBe(409);
    expect(await readOrderState(orderId)).toBe('PENDING');
    const paymentRow = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentRow.status).toBe('REVIEW');

    await prisma.payment.deleteMany({ where: { orderId } });
    await deleteStoreOrder(orderId);
    await deleteStoreProduct(product);
    unregister();
  });

  it('clears purchased items from the cart after a direct single-product order', async () => {
    const prisma = getPrisma();
    const product = await seedProduct({ name: 'Cart-VPS', price: 1000, currency: 'CNY', stock: 10 });
    const add = await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { productId: product, quantity: 3 },
    });
    expect(add.statusCode).toBe(201);
    await app.wallet.adjust({
      userId,
      amount: 10000,
      currency: 'CNY',
      note: 'direct order credit',
    });

    const order = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { productId: product, quantity: 3, paymentMode: 'wallet' },
    });
    expect(order.statusCode).toBe(200);
    const orderBody = order.json() as { order: { id: string; status: string } };
    expect(orderBody.order.status).toBe('PAID');

    const cart = await app.inject({
      method: 'GET',
      url: '/cart',
      headers: { authorization: `Bearer ${userToken}` },
    });
    const cartItems = (cart.json() as { items: Array<{ productId: string }> }).items;
    expect(cartItems.some((item) => item.productId === product)).toBe(false);
    expect(await readProductStock(product)).toBe(7);

    await prisma.$executeRawUnsafe(
      `DELETE FROM "${CART_TABLE}" WHERE "spec"->>'productId' = $1`,
      product,
    );
    await prisma.payment.deleteMany({ where: { orderId: orderBody.order.id } });
    await deleteStoreOrder(orderBody.order.id);
    await deleteStoreProduct(product);
  });

  it('releases stock for expired unpaid external payments via the maintenance sweep', async () => {
    const prisma = getPrisma();
    const product = await seedProduct({ name: 'Expire-VPS', price: 9900, currency: 'CNY', stock: 4 });
    const orderId = await seedOrder({
      userId,
      items: { items: [{ productId: product, quantity: 4 }] },
      total: 39600,
      currency: 'CNY',
      state: 'PENDING',
      settlementTotal: 39600,
      settlementCurrency: 'CNY',
    });
    await prisma.payment.create({
      data: {
        purpose: 'ORDER',
        userId,
        orderId,
        gateway: 'mockpay',
        providerId: 'mockpay',
        paymentMethod: 'mock',
        merchantOrderNo: `sp_ord_expire_${Date.now()}`,
        amount: 39600,
        currency: 'CNY',
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const released = await app.payments.sweepExpired();
    expect(released).toBeGreaterThan(0);

    expect((await prisma.payment.findFirstOrThrow({ where: { orderId } })).status).toBe('CANCELLED');
    expect(await readOrderState(orderId)).toBe('CANCELLED');
    expect(await readProductStock(product)).toBe(8);

    await prisma.payment.deleteMany({ where: { orderId } });
    await deleteStoreOrder(orderId);
    await deleteStoreProduct(product);
  });

  it('returns 404 for store routes once disabled', async () => {
    const disable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/products' })).statusCode).toBe(404);
  });
});

describe.skipIf(!dbAvailable)('manual payment and FX (real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `it_man_admin_${Date.now()}@example.com`;
  const userEmail = `it_man_user_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  let userId = '';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    adminToken = admin.token;
    userToken = user.token;
    userId = user.userId;
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.$executeRawUnsafe(`DELETE FROM "${CART_TABLE}" WHERE "spec"->>'userId' = $1`, userId);
    await prisma.$executeRawUnsafe(`DELETE FROM "${ORDER_TABLE}" WHERE "spec"->>'userId' = $1`, userId);
    await prisma.payment.deleteMany({ where: { userId } });
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('confirms a manual payment and dispatches order release', async () => {
    const prisma = getPrisma();
    // Seed a bank_transfer method on MALL_PC channel so the provider resolves.
    const channel = await prisma.salesChannel.upsert({
      where: { code: 'MALL_PC' },
      create: { code: 'MALL_PC', name: 'PC 端商城', terminal: 'PC' },
      update: {},
    });
    const method = await prisma.paymentMethod.upsert({
      where: { id: 'method_bank_test' },
      create: {
        id: 'method_bank_test',
        channelId: channel.id,
        providerId: 'manual',
        name: '银行转账',
        config: { bankName: 'Test Bank', account: '1234' },
      },
      update: {},
    });

    const product = await seedProduct({ name: 'Manual-VPS', price: 9900, currency: 'CNY', stock: 2 });
    const orderId = await seedOrder({
      userId,
      items: { items: [{ productId: product, quantity: 1 }] },
      total: 9900,
      currency: 'CNY',
      state: 'PENDING',
      channelCode: 'MALL_PC',
      settlementTotal: 9900,
      settlementCurrency: 'CNY',
    });
    const payment = await prisma.payment.create({
      data: {
        purpose: 'ORDER',
        userId,
        orderId,
        methodId: method.id,
        gateway: 'manual',
        providerId: 'manual',
        paymentMethod: 'bank_transfer',
        merchantOrderNo: `sp_ord_manual_${Date.now()}`,
        amount: 9900,
        currency: 'CNY',
        status: 'PENDING',
      },
    });

    // Confirm via admin route.
    const res = await app.inject({
      method: 'POST',
      url: `/admin/payments/${payment.id}/confirm`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'PAID',
    );
    expect(await readOrderState(orderId)).toBe('PAID');

    await prisma.payment.deleteMany({ where: { orderId } });
    await deleteStoreOrder(orderId);
    await deleteStoreProduct(product);
    await prisma.paymentMethod.deleteMany({ where: { id: method.id } });
  });

  it('does not auto-sweep manual payments', async () => {
    const prisma = getPrisma();
    const channel = await prisma.salesChannel.findUniqueOrThrow({ where: { code: 'MALL_PC' } });
    const method = await prisma.paymentMethod.create({
      data: {
        channelId: channel.id,
        providerId: 'manual',
        name: '收款码',
        config: { qrUrl: 'https://x/qr.png' },
      },
    });
    const payment = await prisma.payment.create({
      data: {
        purpose: 'ORDER',
        userId,
        methodId: method.id,
        gateway: 'manual',
        providerId: 'manual',
        paymentMethod: 'qrcode',
        merchantOrderNo: `sp_ord_manual_sweep_${Date.now()}`,
        amount: 9900,
        currency: 'CNY',
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    // Manual provider is built into the kernel, so the sweep must skip it.
    await app.payments.sweepExpired();
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'PENDING',
    );
    await prisma.payment.deleteMany({ where: { id: payment.id } });
    await prisma.paymentMethod.deleteMany({ where: { id: method.id } });
  });

  it('orders a foreign-currency product and settles in CNY via a frozen FX quote', async () => {
    const prisma = getPrisma();
    // Configure USD → CNY at 7.2 (×1e6).
    await app.inject({
      method: 'PUT',
      url: '/admin/currency-rates',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { fromCurrency: 'USD', toCurrency: 'CNY', rate: 7_200_000 },
    });
    const product = await seedProduct({
      name: 'USD Item',
      price: 100000,
      currency: 'USD',
      stock: 5,
    });
    // Fund the user's CNY wallet.
    await app.wallet.credit(userId, 720000, 'CNY', {
      type: 'ADMIN_ADJUST',
      referenceType: 'ADMIN_ADJUST',
      referenceId: `fund_${Date.now()}`,
      note: 'test fund',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { productId: product, quantity: 1, paymentMode: 'wallet' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        currency: string;
        settlementCurrency: string;
        settlementTotal: number;
        fxRate: number | null;
      }>
    >(
      `SELECT "id", "spec"->>'currency' AS "currency",
              "spec"->>'settlementCurrency' AS "settlementCurrency",
              ("spec"->>'settlementTotal')::int AS "settlementTotal",
              ("spec"->>'fxRate')::int AS "fxRate"
         FROM "${ORDER_TABLE}" WHERE "f_userId" = $1 AND "f_state" = 'PAID'
         ORDER BY "created_at" DESC LIMIT 1`,
      userId,
    );
    const order = rows[0];
    if (!order) throw new Error('Expected a settled USD order');
    // Order is USD 100000 but settled as CNY 720000 with a frozen fxRate.
    expect(order.currency).toBe('USD');
    expect(order.settlementCurrency).toBe('CNY');
    expect(order.settlementTotal).toBe(720000);
    expect(order.fxRate).toBe(7_200_000);

    await deleteStoreOrder(order.id);
    await deleteStoreProduct(product);
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
  });

  it('rejects a mixed-currency cart instead of summing different currencies', async () => {
    const prisma = getPrisma();
    await app.inject({
      method: 'PUT',
      url: '/admin/currency-rates',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { fromCurrency: 'USD', toCurrency: 'CNY', rate: 7_200_000 },
    });
    const cnyProduct = await seedProduct({ name: 'CNY Item', price: 1000, currency: 'CNY', stock: 5 });
    const usdProduct = await seedProduct({ name: 'USD Item', price: 1000, currency: 'USD', stock: 5 });
    await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { productId: cnyProduct, quantity: 1 },
    });
    const usdAdd = await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { productId: usdProduct, quantity: 1 },
    });
    const usdItemId = (usdAdd.json() as { item: { id: string } }).item.id;
    const cartItems = (
      await app.inject({
        method: 'GET',
        url: '/cart',
        headers: { authorization: `Bearer ${userToken}` },
      })
    ).json() as { items: Array<{ id: string; currency?: string }> };
    const cnyItem = cartItems.items.find((i) => i.id !== usdItemId);
    if (!cnyItem) throw new Error('购物车缺少 CNY 商品');
    const cnyItemId = cnyItem.id;
    await app.wallet.credit(userId, 100000, 'CNY', {
      type: 'ADMIN_ADJUST',
      referenceType: 'ADMIN_ADJUST',
      referenceId: `mixed_fund_${Date.now()}`,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/cart/checkout',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { cartItemIds: [cnyItemId, usdItemId], paymentMode: 'wallet' },
    });
    expect(res.statusCode).toBe(409);

    await prisma.$executeRawUnsafe(`DELETE FROM "${CART_TABLE}" WHERE "spec"->>'userId' = $1`, userId);
    await deleteStoreProduct(cnyProduct);
    await deleteStoreProduct(usdProduct);
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
  });

  it('rejects non-admin confirmation of a manual payment', async () => {
    const prisma = getPrisma();
    const channel = await prisma.salesChannel.findUniqueOrThrow({ where: { code: 'MALL_PC' } });
    const method = await prisma.paymentMethod.create({
      data: { channelId: channel.id, providerId: 'manual', name: '银行转账', config: {} },
    });
    const payment = await prisma.payment.create({
      data: {
        purpose: 'ORDER',
        userId,
        methodId: method.id,
        gateway: 'manual',
        providerId: 'manual',
        paymentMethod: 'bank_transfer',
        merchantOrderNo: `sp_ord_manual_forbid_${Date.now()}`,
        amount: 9900,
        currency: 'CNY',
        status: 'PENDING',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/payments/${payment.id}/confirm`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'PENDING',
    );
    await prisma.payment.deleteMany({ where: { id: payment.id } });
    await prisma.paymentMethod.deleteMany({ where: { id: method.id } });
  });

  it('concurrent debits never overdraft the balance', async () => {
    const prisma = getPrisma();
    await app.wallet.credit(userId, 1000, 'CNY', {
      type: 'ADMIN_ADJUST',
      referenceType: 'ADMIN_ADJUST',
      referenceId: `conc_fund_${Date.now()}`,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        app.wallet.debit(userId, 100, 'CNY', {
          type: 'ORDER_PAYMENT',
          referenceType: 'ORDER',
          referenceId: `conc_${Date.now()}_${i}`,
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilled).toBe(10);
    const account = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_currency: { userId, currency: 'CNY' } },
    });
    expect(account.balance).toBe(0);
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
  });

  it('lets a pricing interceptor rewrite the order unit price via the waterfall', async () => {
    const prisma = getPrisma();
    const promo = await seedProduct({ name: 'Promo-VPS', price: 10000, currency: 'CNY', stock: 3 });
    await app.wallet.adjust({
      userId,
      amount: 20000,
      currency: 'CNY',
      note: 'pricing test credit',
    });
    // A promotional policy: 10% off whatever price the store computed.
    const stop = getEventBus().intercept<{ unit: number }>('store.order.price', (value, next) =>
      next({ ...value, unit: Math.round(value.unit * 0.9) }),
    );
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { productId: promo, quantity: 1, paymentMode: 'wallet' },
      });
      expect(res.statusCode).toBe(200);
      // Product price is 10000; the interceptor applies 10% off → 9000.
      expect((res.json() as { order: { total: number } }).order.total).toBe(9000);
    } finally {
      stop();
    }
    await deleteStoreProduct(promo);
    await prisma.$executeRawUnsafe(`DELETE FROM "${ORDER_TABLE}" WHERE "spec"->>'userId' = $1`, userId);
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
  });
});
