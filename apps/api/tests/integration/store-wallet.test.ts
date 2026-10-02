import type { FastifyInstance } from 'fastify';
import type { PaymentProvider } from '@stackpanel/sdk';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

describe.skipIf(!dbAvailable)('store-wallet plugin wallet integration (real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `sw_admin_${Date.now()}@example.com`;
  const userEmail = `sw_user_${Date.now()}@example.com`;
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
    await prisma.plugin.deleteMany({ where: { id: { in: ['store', 'store-wallet'] } } });

    const enableStore = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enableStore.statusCode).toBe(200);
    const enableWallet = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store-wallet',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enableWallet.statusCode).toBe(200);
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.payment.deleteMany({ where: { userId } });
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await prisma.plugin.deleteMany({ where: { id: { in: ['store', 'store-wallet'] } } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('requires auth for wallet routes', async () => {
    expect((await app.inject({ method: 'GET', url: '/wallet' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/wallet/topups', payload: {} })).statusCode,
    ).toBe(401);
  });

  it('rejects invalid top-up params with a stable code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/topups',
      headers: { authorization: `Bearer ${userToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('wallet.topup.params_invalid');
  });

  it('returns an empty wallet for a fresh user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/wallet',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      account: { balance: number; currency: string };
      entries: unknown[];
      topUps: unknown[];
    };
    expect(body.account.balance).toBe(0);
    expect(body.entries).toEqual([]);
    expect(body.topUps).toEqual([]);
  });

  it('allows a tracked administrator wallet adjustment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/admin/wallets/adjustments',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email: userEmail, amount: 9900, note: 'integration credit' },
    });
    expect(res.statusCode).toBe(200);
    const wallet = await getPrisma().walletAccount.findUniqueOrThrow({ where: { userId_currency: { userId, currency: 'CNY' } } });
    expect(wallet.balance).toBe(9900);
    expect(
      await getPrisma().walletLedgerEntry.count({ where: { userId, type: 'ADMIN_ADJUST' } }),
    ).toBe(1);
  });

  it('lists wallets for admins with emails', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store/admin/wallets',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const accounts = (
      res.json() as { accounts: Array<{ userId: string; email: string; balance: number }> }
    ).accounts;
    const mine = accounts.find((account) => account.userId === userId);
    expect(mine?.email).toBe(userEmail);
    expect(mine?.balance).toBe(9900);
  });

  it('creates a top-up through the kernel and returns a payment URL', async () => {
    const mockProvider: PaymentProvider = {
      id: 'mockpay',
      name: 'Mock Pay',
      mode: 'gateway',
      callbackPath: '/callbacks/mockpay',
      getMethods: () => [{ id: 'mock', label: 'Mock', topUpAmounts: [5000] }],
      createPayment: async () => ({
        externalId: 'ext_top_1',
        paymentUrl: 'https://pay.mock/topup',
      }),
      closePayment: vi.fn(async () => true),
    };
    const unregister = app.pluginRuntime.registerExtension(
      EXTENSION_POINTS.paymentProvider,
      mockProvider,
      'mockpay',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/topups',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { amount: 5000, providerId: 'mockpay', paymentMethod: 'mock' },
    });
    expect(res.statusCode).toBe(200);
    const topUp = (res.json() as { topUp: { id: string; status: string; paymentUrl: string } })
      .topUp;
    expect(topUp.status).toBe('PENDING');
    expect(topUp.paymentUrl).toBe('https://pay.mock/topup');
    const record = await getPrisma().payment.findUniqueOrThrow({ where: { id: topUp.id } });
    expect(record.purpose).toBe('TOP_UP');
    expect(record.userId).toBe(userId);
    unregister();
  });

  it('cancels a pending top-up through the provider', async () => {
    const prisma = getPrisma();
    const mockProvider: PaymentProvider = {
      id: 'mockpay',
      name: 'Mock Pay',
      mode: 'gateway',
      callbackPath: '/callbacks/mockpay',
      getMethods: () => [{ id: 'mock', label: 'Mock', topUpAmounts: [5000] }],
      createPayment: async () => ({
        externalId: 'ext_top_2',
        paymentUrl: 'https://pay.mock/topup2',
      }),
      closePayment: vi.fn(async () => true),
    };
    const unregister = app.pluginRuntime.registerExtension(
      EXTENSION_POINTS.paymentProvider,
      mockProvider,
      'mockpay',
    );
    const payment = await prisma.payment.create({
      data: {
        purpose: 'TOP_UP',
        userId,
        gateway: 'mockpay',
        providerId: 'mockpay',
        paymentMethod: 'mock',
        merchantOrderNo: `sp_top_cancel_${Date.now()}`,
        amount: 1000,
        currency: 'CNY',
        status: 'PENDING',
      },
    });
    const cancel = await app.inject({
      method: 'POST',
      url: `/wallet/topups/${payment.id}/cancel`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { cancelled: boolean }).cancelled).toBe(true);
    expect(mockProvider.closePayment).toHaveBeenCalledWith(
      expect.objectContaining({ merchantOrderNo: payment.merchantOrderNo }),
    );
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'CANCELLED',
    );
    unregister();
  });

  it('credits a top-up once even if the payment gateway retries the callback', async () => {
    const prisma = getPrisma();
    const payment = await prisma.payment.create({
      data: {
        purpose: 'TOP_UP',
        userId,
        gateway: 'epay',
        providerId: 'epay',
        paymentMethod: 'wxpay',
        merchantOrderNo: `sp_top_settle_${Date.now()}`,
        amount: 5000,
        currency: 'CNY',
        status: 'PENDING',
      },
    });
    const settled = {
      providerId: 'epay',
      merchantOrderNo: payment.merchantOrderNo as string,
      externalId: 'trade_456',
      amount: 5000,
      currency: 'CNY',
    };
    expect((await app.payments.settle(settled)).applied).toBe(true);
    expect((await app.payments.settle(settled)).applied).toBe(false);
    expect((await prisma.walletAccount.findUniqueOrThrow({ where: { userId_currency: { userId, currency: 'CNY' } } })).balance).toBe(
      14900,
    );
    expect(
      await prisma.walletLedgerEntry.count({
        where: { userId, type: 'TOP_UP', referenceId: payment.id },
      }),
    ).toBe(1);
  });

  it('keeps per-currency wallet accounts separate', async () => {
    const prisma = getPrisma();
    const cnyBefore = (await prisma.walletAccount.findUniqueOrThrow({ where: { userId_currency: { userId, currency: 'CNY' } } })).balance;
    // A USD credit opens a separate USD account and does not touch CNY.
    await app.wallet.credit(userId, 100, 'USD', {
      type: 'TOP_UP',
      referenceType: 'TOP_UP',
      referenceId: `usd_credit_${Date.now()}`,
    });
    const usd = await prisma.walletAccount.findUniqueOrThrow({ where: { userId_currency: { userId, currency: 'USD' } } });
    expect(usd.balance).toBe(100);
    // CNY balance unchanged.
    expect((await prisma.walletAccount.findUniqueOrThrow({ where: { userId_currency: { userId, currency: 'CNY' } } })).balance).toBe(
      cnyBefore,
    );
    // A USD debit exceeding the USD balance fails (insufficient), CNY unaffected.
    await expect(
      app.wallet.debit(userId, 1000, 'USD', {
        type: 'ORDER_PAYMENT',
        referenceType: 'ORDER',
        referenceId: `usd_debit_${Date.now()}`,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await prisma.walletAccount.findUniqueOrThrow({ where: { userId_currency: { userId, currency: 'CNY' } } })).balance).toBe(
      cnyBefore,
    );
  });

  it('sweeps expired top-ups to CANCELLED', async () => {
    const prisma = getPrisma();
    const payment = await prisma.payment.create({
      data: {
        purpose: 'TOP_UP',
        userId,
        gateway: 'mockpay',
        providerId: 'mockpay',
        paymentMethod: 'mock',
        merchantOrderNo: `sp_top_expire_${Date.now()}`,
        amount: 1000,
        currency: 'CNY',
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const released = await app.payments.sweepExpired();
    expect(released).toBeGreaterThan(0);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'CANCELLED',
    );
  });

  it('returns 404 for wallet routes once the plugin is disabled', async () => {
    const disable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store-wallet',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/wallet',
          headers: { authorization: `Bearer ${userToken}` },
        })
      ).statusCode,
    ).toBe(404);
  });
});