import { EXTENSION_POINTS, definePlugin, PluginError } from '@stackpanel/sdk';
import type {
  ProductTypeProvider,
  ProvisionContext,
  ProvisionResult,
} from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * Cloud server is a product classification, not a provider implementation.
 * Real regions, images, prices and operations must come from the bound provider.
 */
const configSchema = z.object({}).passthrough();

const cloudServerType: ProductTypeProvider = {
  id: 'store-product-server',
  name: '云服务器',
  label: '云服务器',
  fulfillmentTypes: ['cloud_server'],
  configFields: [],
  configSchema,
  async provision(_ctx: ProvisionContext): Promise<ProvisionResult> {
    // Defensive fallback for records created before the store enforced a provider.
    throw new PluginError(
      'store.cloud_server.provider_required',
      409,
      '云服务器商品未绑定真实履约提供方，无法开通服务',
    );
  },
};

export const storeProductServerPlugin = definePlugin({
  manifest: {
    id: 'store-product-server',
    name: '云服务器商品类型',
    version: '0.3.0',
    description: '云服务器商品类型。商品必须绑定真实履约提供方，配置由上游商品返回。',
    requires: ['store'],
  },
  onActivate: (ctx) => {
    ctx.registerExtension(EXTENSION_POINTS.productType, cloudServerType);
    ctx.logger.info('store-product-server: activated');
  },
  onDeactivate: (ctx) => {
    ctx.logger.info('store-product-server: deactivated');
  },
});

export default storeProductServerPlugin;
