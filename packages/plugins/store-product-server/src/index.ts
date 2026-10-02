import {
  EXTENSION_POINTS,
  computeCheckoutPrice,
  readCheckoutConfig,
  definePlugin,
  PluginError,
} from '@stackpanel/sdk';
import type {
  CheckoutPriceContext,
  CheckoutPriceResult,
  FulfillmentProvider,
  ProductConfigField,
  ProductTypeProvider,
  ProvisionContext,
  ProvisionResult,
  ProviderServiceContext,
  ServiceDetail,
} from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * 云服务器商品类型插件。
 *
 * 只定义「云服务器」这个商品类型的形态：类型配置字段（区域/规格/计费周期）、
 * 后端校验 schema、以及「本平台即上游」的本地履约（占位/托管，不依赖任何外部上游）。
 * 商品可额外关联外部上游（如 zjmf）——由上游插件经 `upstream.product.source` 提供，
 * 本插件对具体上游零依赖。
 */

const configSchema = z
  .object({
    region: z.string().min(1).max(64),
    specs: z
      .object({
        cpu: z.number().int().positive().optional(),
        memory: z.number().int().positive().optional(),
        disk: z.number().int().positive().optional(),
        bandwidth: z.number().int().positive().optional(),
      })
      .optional(),
    billingCycle: z.enum(['monthly', 'yearly']).optional(),
  })
  .passthrough();

const configFields: ProductConfigField[] = [
  {
    name: 'region',
    label: '区域',
    type: 'select',
    required: true,
    options: [
      { label: '华东', value: 'east-china' },
      { label: '华南', value: 'south-china' },
      { label: '华北', value: 'north-china' },
      { label: '西南', value: 'southwest-china' },
    ],
  },
  { name: 'specs.cpu', label: 'CPU（核）', type: 'number', min: 1 },
  { name: 'specs.memory', label: '内存（GB）', type: 'number', min: 1 },
  { name: 'specs.disk', label: '数据盘（GB）', type: 'number', min: 0 },
  { name: 'specs.bandwidth', label: '带宽（Mbps）', type: 'number', min: 1 },
  {
    name: 'billingCycle',
    label: '计费周期',
    type: 'select',
    options: [
      { label: '月付', value: 'monthly' },
      { label: '年付', value: 'yearly' },
    ],
  },
];

/** 本平台即上游的本地履约：不调用外部，按商品配置生成交付物。 */
const localProvider: FulfillmentProvider = {
  id: 'store-product-server',
  name: '云服务器（本平台）',
  fulfillmentTypes: ['cloud_server'],

  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    const metadata = (ctx.product.metadata ?? {}) as Record<string, unknown>;
    const selection = (ctx.config?.selections ?? {}) as Record<string, unknown>;
    return {
      status: 'ACTIVE',
      providerServiceId: null,
      runtime: {
        status: 'ACTIVE',
        ...(typeof metadata.specs === 'object' && metadata.specs !== null
          ? { specs: metadata.specs }
          : {}),
        ...(typeof metadata.region === 'string' ? { region: metadata.region } : {}),
        ...(ctx.config
          ? {
              checkoutConfig: {
                cycle: ctx.config.cycle ?? null,
                selections: selection,
                summary: ctx.config.summary ?? null,
              },
            }
          : {}),
      },
      message: '云服务器已开通（本平台托管）',
    };
  },

  /** 本地可配置商品：按 metadata.checkoutConfig 静态计价。 */
  async calculateCheckoutPrice(ctx: CheckoutPriceContext): Promise<CheckoutPriceResult> {
    const schema = readCheckoutConfig(ctx.product.metadata);
    if (!schema) throw new PluginError('store.product.config_unsupported', 400, '该商品未配置可选项');
    return computeCheckoutPrice(schema, ctx.config);
  },

  async getDetail(service: ProviderServiceContext): Promise<ServiceDetail> {
    const runtime = (service.service.runtime ?? {}) as Record<string, unknown>;
    const fields: ServiceDetail['fields'] = [
      { label: '状态', value: '正常' },
      ...(typeof runtime.region === 'string' ? [{ label: '区域', value: runtime.region }] : []),
    ];
    const specs = runtime.specs as Record<string, unknown> | undefined;
    if (specs) {
      for (const [key, value] of Object.entries(specs)) {
        fields.push({ label: key, value: String(value) });
      }
    }
    const config = runtime.checkoutConfig as
      | { cycle?: string | null; selections?: Record<string, unknown>; summary?: string | null }
      | undefined;
    if (config?.summary) {
      fields.push({ label: '配置', value: config.summary });
    }
    return { title: '云服务器', status: 'ACTIVE', fields };
  },
};

const productType: ProductTypeProvider = {
  ...localProvider,
  label: '云服务器',
  configFields,
  configSchema,
};

export const storeProductServerPlugin = definePlugin({
  manifest: {
    id: 'store-product-server',
    name: '云服务器商品类型',
    version: '0.1.0',
    description:
      '云服务器商品类型：类型配置字段 + 本平台即上游的本地履约（占位/托管）。可关联外部上游。',
    requires: ['store'],
  },
  onActivate: (ctx) => {
    ctx.registerExtension(EXTENSION_POINTS.productType, productType);
    ctx.registerExtension(EXTENSION_POINTS.fulfillmentProvider, localProvider);
    ctx.logger.info('store-product-server: activated');
  },
  onDeactivate: (ctx) => {
    ctx.logger.info('store-product-server: deactivated');
  },
});

export default storeProductServerPlugin;
