import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

const PRODUCT_TABLE = 'ext_store_product';
const ORDER_TABLE = 'ext_store_order';

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function seedProduct(input: {
  name: string;
  price: number;
  currency?: string;
  stock?: number;
}): Promise<string> {
  const id = newId('prod');
  const spec = {
    name: input.name,
    description: null,
    price: input.price,
    currency: input.currency ?? 'CNY',
    cost: null,
    originalPrice: null,
    discount: null,
    stock: input.stock ?? 5,
    status: 'ACTIVE',
    metadata: null,
    categoryId: null,
    fulfillmentType: 'instant',
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
    input.stock ?? 5,
  );
  return id;
}

describe.skipIf(!dbAvailable)('currency accuracy and governance (real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `cur_admin_${Date.now()}@example.com`;
  const userEmail = `cur_user_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  let userId = '';
  const created: string[] = [];

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    adminToken = admin.token;
    userToken = user.token;
    userId = user.userId;
    await getPrisma().plugin.deleteMany({ where: { id: 'store' } });
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
    for (const id of created) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${PRODUCT_TABLE}" WHERE "id" = $1`, id);
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM "${ORDER_TABLE}" WHERE "spec"->>'userId' = $1`,
      userId,
    );
    await prisma.payment.deleteMany({ where: { userId } });
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await prisma.fxRate.deleteMany({ where: { fromCurrency: { in: ['USD', 'EUR'] } } });
    await prisma.setting.deleteMany({ where: { key: 'currency.settlement' } });
    await prisma.currencyDefinition.deleteMany({});
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('exposes enabled currencies with minor-unit metadata publicly', async () => {
    const res = await app.inject({ method: 'GET', url: '/currency-definitions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      currencies: Array<{ code: string; name: string; symbol: string; minorUnit: number }>;
    };
    const cny = body.currencies.find((currency) => currency.code === 'CNY');
    const jpy = body.currencies.find((currency) => currency.code === 'JPY');
    expect(cny).toMatchObject({ code: 'CNY', minorUnit: 2 });
    expect(jpy).toMatchObject({ code: 'JPY', minorUnit: 0 });
  });

  it('requires an admin to read the governance list', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/admin/currency-definitions' })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/admin/currency-definitions',
          headers: { authorization: `Bearer ${userToken}` },
        })
      ).statusCode,
    ).toBe(403);

    const res = await app.inject({
      method: 'GET',
      url: '/admin/currency-definitions',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      settlementCurrency: string;
      currencies: Array<{ code: string; settlement: boolean }>;
    };
    expect(body.settlementCurrency).toBe('CNY');
    expect(body.currencies.find((currency) => currency.code === 'CNY')?.settlement).toBe(true);
  });

  it('rejects unknown currency codes and refuses to disable the settlement currency', async () => {
    const unknown = await app.inject({
      method: 'PATCH',
      url: '/admin/currency-definitions/BTC',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(unknown.statusCode).toBe(400);
    expect((unknown.json() as { code: string }).code).toBe('currency.invalid');

    const disableSettlement = await app.inject({
      method: 'PATCH',
      url: '/admin/currency-definitions/CNY',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(disableSettlement.statusCode).toBe(409);
    expect((disableSettlement.json() as { code: string }).code).toBe(
      'currency.settlement_unsupported',
    );
  });

  it('toggles a currency and hides it from the public catalog', async () => {
    const disable = await app.inject({
      method: 'PATCH',
      url: '/admin/currency-definitions/EUR',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    expect((disable.json() as { currency: { enabled: boolean } }).currency.enabled).toBe(false);

    const publicList = await app.inject({ method: 'GET', url: '/currency-definitions' });
    const codes = (publicList.json() as { currencies: Array<{ code: string }> }).currencies.map(
      (currency) => currency.code,
    );
    expect(codes).not.toContain('EUR');

    const create = await app.inject({
      method: 'POST',
      url: '/store/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'EUR product', price: 1000, stock: 1, currency: 'EUR' },
    });
    expect(create.statusCode).toBe(409);
    expect((create.json() as { code: string }).code).toBe('currency.disabled');

    const reenable = await app.inject({
      method: 'PATCH',
      url: '/admin/currency-definitions/EUR',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(reenable.statusCode).toBe(200);
  });

  it('rejects free-text and aliased product currencies at the API boundary', async () => {
    const btc = await app.inject({
      method: 'POST',
      url: '/store/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'BTC product', price: 1000, stock: 1, currency: 'BTC' },
    });
    expect(btc.statusCode).toBe(400);
    expect((btc.json() as { code: string }).code).toBe('currency.invalid');

    // Documented aliases are normalized, not rejected.
    const rmb = await app.inject({
      method: 'POST',
      url: '/store/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'RMB product', price: 1000, stock: 1, currency: 'rmb' },
    });
    expect(rmb.statusCode).toBe(201);
    const product = (rmb.json() as { product: { id: string; currency: string } }).product;
    created.push(product.id);
    expect(product.currency).toBe('CNY');
  });

  it('does not let a traded product change currency', async () => {
    const product = await seedProduct({ name: 'Locked', price: 1000, currency: 'CNY' });
    created.push(product);
    // A service instance referencing the product is enough to lock it.
    await getPrisma().$executeRawUnsafe(
      `INSERT INTO "ext_store_service-instance"
         ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
          "created_at", "updated_at", "f_userId", "f_productId", "f_state")
       VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
               now(), now(), $3, $4, 'ACTIVE')`,
      newId('svc'),
      JSON.stringify({
        userId,
        orderId: null,
        productId: product,
        productName: 'Locked',
        fulfillmentType: 'instant',
        providerId: null,
        providerServiceId: null,
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 1000,
        currency: 'CNY',
        provisionedAt: new Date().toISOString(),
        expiresAt: null,
      }),
      userId,
      product,
    );

    const res = await app.inject({
      method: 'PATCH',
      url: `/store/admin/products/${product}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { currency: 'USD' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('currency.product_immutable');

    await getPrisma().$executeRawUnsafe(
      `DELETE FROM "ext_store_service-instance" WHERE "f_productId" = $1`,
      product,
    );
  });

  it('refuses an FX rate targeting something other than the settlement currency', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/currency-rates',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { fromCurrency: 'USD', toCurrency: 'EUR', rate: 900_000 },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('currency.settlement_unsupported');
  });

  it('validates FX rate currencies and refuses unknown codes', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/currency-rates',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { fromCurrency: 'BTC', toCurrency: 'CNY', rate: 1_000_000 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('currency.invalid');
  });

  it('refuses an order when the configured rate has expired', async () => {
    const prisma = getPrisma();
    await prisma.fxRate.upsert({
      where: { fromCurrency_toCurrency: { fromCurrency: 'USD', toCurrency: 'CNY' } },
      create: {
        fromCurrency: 'USD',
        toCurrency: 'CNY',
        rate: 7_200_000,
        validUntil: new Date(Date.now() - 60_000),
      },
      update: { rate: 7_200_000, validUntil: new Date(Date.now() - 60_000) },
    });
    const product = await seedProduct({ name: 'Expired FX', price: 10_000, currency: 'USD' });
    created.push(product);
    await app.wallet.credit(userId, 100_000, 'CNY', {
      type: 'ADMIN_ADJUST',
      referenceType: 'ADMIN_ADJUST',
      referenceId: `expired_fx_${Date.now()}`,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { productId: product, quantity: 1, paymentMode: 'wallet' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('currency.rate_expired');
    // Stock is untouched: the quote fails before the order is reserved.
    const rows = await prisma.$queryRawUnsafe<Array<{ f_stock: number }>>(
      `SELECT "f_stock" FROM "${PRODUCT_TABLE}" WHERE "id" = $1`,
      product,
    );
    expect(rows[0]?.f_stock).toBe(5);

    await prisma.fxRate.deleteMany({ where: { fromCurrency: 'USD', toCurrency: 'CNY' } });
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
  });

  it('blocks a wallet payment when settlement leaves CNY', async () => {
    const prisma = getPrisma();
    const setSettlement = await app.inject({
      method: 'PUT',
      url: '/admin/settings/settlement-currency',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { currency: 'USD' },
    });
    expect(setSettlement.statusCode).toBe(200);
    expect((setSettlement.json() as { settlementCurrency: string }).settlementCurrency).toBe('USD');

    const product = await seedProduct({ name: 'USD settled', price: 1_000, currency: 'USD' });
    created.push(product);
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { productId: product, quantity: 1, paymentMode: 'wallet' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('currency.payment_method_unsupported');

    // Reset to CNY for the rest of the suite.
    await app.inject({
      method: 'PUT',
      url: '/admin/settings/settlement-currency',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { currency: 'CNY' },
    });
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
  });

  it('refuses a settlement currency that an enabled payment method cannot collect', async () => {
    const prisma = getPrisma();
    const channel = await prisma.salesChannel.findUniqueOrThrow({ where: { code: 'MALL_PC' } });
    const method = await prisma.paymentMethod.create({
      data: {
        channelId: channel.id,
        providerId: 'manual',
        name: 'CNY only',
        enabled: true,
        scene: 'PC',
        currencies: ['CNY'],
        config: {},
      },
    });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/settings/settlement-currency',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { currency: 'USD' },
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { code: string }).code).toBe('currency.payment_method_unsupported');
      // The setting must not have moved.
      const current = await app.inject({
        method: 'GET',
        url: '/admin/settings/settlement-currency',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect((current.json() as { settlementCurrency: string }).settlementCurrency).toBe('CNY');
    } finally {
      await prisma.paymentMethod.delete({ where: { id: method.id } });
    }
  });

  it('reports products withheld by the legacy currency migration', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store/admin/currency-issues',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('issues');
  });

  it('rejects a payment method that cannot collect the settlement currency', async () => {
    const prisma = getPrisma();
    const channel = await prisma.salesChannel.findUniqueOrThrow({ where: { code: 'MALL_PC' } });
    const method = await prisma.paymentMethod.create({
      data: {
        channelId: channel.id,
        providerId: 'manual',
        name: 'USD only',
        enabled: true,
        scene: 'PC',
        currencies: ['USD'],
        config: {},
      },
    });
    try {
      const product = await seedProduct({ name: 'CNY ext', price: 1_000, currency: 'CNY' });
      created.push(product);
      const res = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          productId: product,
          quantity: 1,
          paymentMode: 'external',
          providerId: 'manual',
          paymentMethod: 'bank_transfer',
          methodId: method.id,
        },
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { code: string }).code).toBe('currency.payment_method_unsupported');
    } finally {
      await prisma.paymentMethod.delete({ where: { id: method.id } });
    }
  });
});
