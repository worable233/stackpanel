import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FulfillmentProvider, PluginContext } from '@stackpanel/sdk';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import { diagnoseProduct, sellabilityBlocker } from './fulfillment-diagnostics';
import { assertSellableProduct } from './orders';

/**
 * A product's deliverability depends on *runtime plugin state*, not on the row.
 *
 * An operator disables or uninstalls an upstream plugin and the catalog row stays
 * ACTIVE: the catalogue lists it, add-to-cart succeeds, and the failure only
 * surfaces during fulfillment — after the customer paid. `assertSellableProduct`
 * is the pre-payment gate; `diagnoseProduct` is the same rule surfaced to admins.
 * They must never disagree, so both are pinned here.
 */
function bindProviders(providers: FulfillmentProvider[]): void {
  bindContext({
    getExtensions: (pointId: string) =>
      (pointId === EXTENSION_POINTS.fulfillmentProvider ? providers : []) as never,
  } as unknown as PluginContext);
}

const cloudProvider = {
  id: 'zjmf',
  name: '智简魔方',
  fulfillmentTypes: ['cloud_server'],
} as FulfillmentProvider;

const cloudProduct = {
  id: 'p1',
  name: '香港EPYC-4H8G',
  status: 'ACTIVE',
  fulfillmentType: 'cloud_server',
  providerId: 'zjmf',
  providerProductId: '198',
};

describe('sellability diagnosis', () => {
  beforeEach(resetContext);
  afterEach(resetContext);

  it('reports PROVIDER_MISSING when the bound plugin is not active', () => {
    bindProviders([]);
    const issue = diagnoseProduct(cloudProduct, []);
    expect(issue).toMatchObject({ code: 'PROVIDER_MISSING', blocking: true });
    // The operator needs the exact plugin id to act on.
    expect(issue?.message).toContain('zjmf');
  });

  it('reports NO_PROVIDER when a cloud server has no binding at all', () => {
    const issue = diagnoseProduct({ ...cloudProduct, providerId: null }, [cloudProvider]);
    expect(issue).toMatchObject({ code: 'NO_PROVIDER', blocking: true });
  });

  it('avoids suggesting a rebind when no provider supports cloud servers', () => {
    // A fresh install has only card/membership providers. Telling the operator
    // to "rebind" sends them hunting for an entry that does not exist.
    const issue = diagnoseProduct(cloudProduct, [
      { id: 'cards', name: '卡密', fulfillmentTypes: ['card'] } as FulfillmentProvider,
    ]);
    expect(issue?.message).toContain('没有支持云服务');
    expect(issue?.message).not.toContain('改绑');
  });

  it('reports PROVIDER_TYPE_UNSUPPORTED when the provider cannot do cloud servers', () => {
    const issue = diagnoseProduct(cloudProduct, [
      { id: 'zjmf', name: '卡密', fulfillmentTypes: ['card'] } as FulfillmentProvider,
    ]);
    expect(issue).toMatchObject({ code: 'PROVIDER_TYPE_UNSUPPORTED', blocking: true });
  });

  it('passes a cloud server bound to a live provider', () => {
    expect(diagnoseProduct(cloudProduct, [cloudProvider])).toBeNull();
  });

  it('marks a delisted product as a non-blocking issue, not a fault', () => {
    const issue = diagnoseProduct({ ...cloudProduct, status: 'INACTIVE' }, []);
    expect(issue).toMatchObject({ code: 'INACTIVE', blocking: false });
  });

  it('reports a missing provider for non-cloud products that bound one', () => {
    const issue = diagnoseProduct(
      { ...cloudProduct, fulfillmentType: 'card', providerId: 'gone' },
      [],
    );
    expect(issue).toMatchObject({ code: 'PROVIDER_MISSING', blocking: true });
  });

  it('leaves an unbound instant product alone (type plugin handles it)', () => {
    expect(
      diagnoseProduct({ ...cloudProduct, fulfillmentType: 'instant', providerId: null }, []),
    ).toBeNull();
  });
});

describe('pre-payment gate', () => {
  beforeEach(resetContext);
  afterEach(resetContext);

  it('refuses to sell a cloud server whose provider plugin is gone', () => {
    bindProviders([]);
    // The message names the missing plugin so the buyer's error is actionable
    // when relayed to an operator.
    expect(() => assertSellableProduct(cloudProduct)).toThrow('zjmf');
  });

  it('refuses a cloud server with no provider bound', () => {
    bindProviders([cloudProvider]);
    expect(() => assertSellableProduct({ ...cloudProduct, providerId: null })).toThrow(
      '云服务器商品必须绑定真实履约提供方',
    );
  });

  it('allows a cloud server with a live provider', () => {
    bindProviders([cloudProvider]);
    expect(() => assertSellableProduct(cloudProduct)).not.toThrow();
  });

  it('allows non-cloud products with no binding, whose type plugin fulfils them', () => {
    bindProviders([]);
    expect(() =>
      assertSellableProduct({
        ...cloudProduct,
        fulfillmentType: 'instant',
        providerId: null,
      }),
    ).not.toThrow();
  });

  it('exposes the same blocker the admin panel reports', () => {
    bindProviders([]);
    expect(sellabilityBlocker(cloudProduct)).toMatchObject({ code: 'PROVIDER_MISSING' });
  });
});
