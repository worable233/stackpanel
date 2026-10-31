/**
 * Regression: gateway checkout must survive `isolated` payment providers.
 *
 * An isolated plugin's extension methods are async proxies across a process
 * boundary, so `PaymentProvider.getMethods()` cannot resolve synchronously —
 * the kernel gets a `Promise` back. Treating it as an array produced exactly two
 * production failures:
 *
 *   - `provider.getMethods().some(...)` → `TypeError: .some is not a function`
 *     → **500 on every gateway top-up and every gateway checkout**;
 *   - `listPaymentMethods()` → `methods: {}` (a Promise serialized away), so the
 *     buyer-facing catalogue advertised a gateway with no methods at all.
 *
 * The fix is to `await` provider capabilities everywhere. These cases pin that
 * down using an async-only provider, which is what an isolated plugin looks like
 * from the kernel's side.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PaymentProvider } from '@stackpanel/sdk';
import { PaymentsService } from '../../src/payments/payments-service.ts';

/** A gateway provider whose capabilities can only be `await`ed. */
function asyncProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    id: 'epay',
    name: '易支付',
    mode: 'gateway',
    callbackPath: '/callbacks/epay',
    // Deliberately async: mirrors the isolated-plugin proxy shape.
    getMethods: async () => [{ id: 'alipay', label: '支付宝' }],
    createPayment: async () => ({ externalId: 'x', paymentUrl: 'https://example.com/pay' }),
    ...overrides,
  } as PaymentProvider;
}

interface ServiceOptions {
  providers: PaymentProvider[];
  configuredProviders?: string[];
}

function service({ providers, configuredProviders = ['epay'] }: ServiceOptions) {
  const db = {
    paymentMethod: {
      findMany: async () => configuredProviders.map((providerId) => ({ providerId, currencies: [] })),
      findFirst: async () => ({ id: 'method_epay' }),
      findUnique: async () => ({ id: 'method_epay', config: {} }),
    },
  };
  return new PaymentsService({
    db: db as never,
    events: { publish: vi.fn(), nudgeRelay: vi.fn() } as never,
    wallet: {} as never,
    getProviders: () => providers,
    getSettlementHandlers: () => [],
  });
}

describe('payment provider capabilities across the isolation boundary', () => {
  it('lists methods instead of serializing a Promise away', async () => {
    const listing = await service({ providers: [asyncProvider()] }).listPaymentMethods();
    expect(listing.providers).toHaveLength(1);
    expect(listing.providers[0]?.methods).toEqual([{ id: 'alipay', label: '支付宝' }]);
  });

  it('keeps the buyer-facing catalogue filtered but populated', async () => {
    const listing = await service({ providers: [asyncProvider()] }).listAvailablePaymentMethods();
    expect(listing.providers[0]?.id).toBe('epay');
    expect(listing.providers[0]?.methods).toEqual([{ id: 'alipay', label: '支付宝' }]);
  });

  it('accepts a creation request for a method the async provider really offers', async () => {
    const svc = service({ providers: [asyncProvider()] });
    const db = (svc as unknown as { options: { db: Record<string, unknown> } }).options.db;
    db.payment = {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'pay_1',
        externalId: null,
        status: 'PENDING',
        ...data,
      }),
    };
    // The point is that validation passed: an async capability list no longer
    // blocks a legitimate gateway method. The returned row shape is the mocked
    // db's business, so only the identifier is asserted.
    await expect(
      svc.createRecord({
        purpose: 'TOP_UP',
        userId: 'user-1',
        amount: 1000,
        currency: 'CNY',
        providerId: 'epay',
        paymentMethod: 'alipay',
        subject: '钱包充值',
        returnPath: '/account/balance',
      }),
    ).resolves.toMatchObject({ id: 'pay_1' });
  });

  it('still rejects a method the provider does not offer', async () => {
    const svc = service({ providers: [asyncProvider()] });
    const db = (svc as unknown as { options: { db: Record<string, unknown> } }).options.db;
    db.payment = { findUnique: async () => null, create: async () => ({}) };
    await expect(
      svc.createRecord({
        purpose: 'TOP_UP',
        userId: 'user-1',
        amount: 1000,
        currency: 'CNY',
        providerId: 'epay',
        paymentMethod: 'bitcoin',
        subject: '钱包充值',
        returnPath: '/account/balance',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
