import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FulfillmentProvider, PluginContext } from '@stackpanel/sdk';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import { assertCloudServerProvider } from './products';

function bindProviders(providers: FulfillmentProvider[]): void {
  bindContext({
    getExtensions: (pointId: string) =>
      (pointId === EXTENSION_POINTS.fulfillmentProvider ? providers : []) as never,
  } as unknown as PluginContext);
}

describe('cloud-server fulfillment boundary', () => {
  beforeEach(resetContext);
  afterEach(resetContext);

  it('rejects cloud-server products without a fulfillment provider', () => {
    expect(() => assertCloudServerProvider('cloud_server', null)).toThrow(
      '云服务器商品必须绑定真实履约提供方',
    );
  });

  it('rejects a cloud-server provider that is not active', () => {
    bindProviders([]);
    expect(() => assertCloudServerProvider('cloud_server', 'zjmf')).toThrow(
      '所选云服务器履约提供方未启用',
    );
  });

  it('rejects an active provider that does not support cloud servers', () => {
    bindProviders([{ id: 'zjmf', fulfillmentTypes: ['upstream_service'] } as FulfillmentProvider]);
    expect(() => assertCloudServerProvider('cloud_server', 'zjmf')).toThrow(
      '所选履约提供方不支持云服务器商品',
    );
  });

  it('accepts an active fulfillment provider', () => {
    bindProviders([{ id: 'zjmf', fulfillmentTypes: ['cloud_server'] } as FulfillmentProvider]);
    expect(() => assertCloudServerProvider('cloud_server', 'zjmf')).not.toThrow();
  });
});
