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
  ServiceActionResult,
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
    const powerState = typeof runtime.powerState === 'string' ? runtime.powerState : 'running';
    const status = powerState === 'stopped' ? 'SUSPENDED' : 'ACTIVE';
    const fields: ServiceDetail['fields'] = [
      { label: '电源状态', value: powerState === 'stopped' ? '已关机' : '运行中' },
      ...(typeof runtime.os === 'string' ? [{ label: '操作系统', value: runtime.os }] : []),
      ...(typeof runtime.region === 'string' ? [{ label: '区域', value: runtime.region }] : []),
      // VNC 控制台地址（点开控制台后写入 runtime，刷新后仍可见）。
      ...(typeof runtime.consoleUrl === 'string'
        ? [{ label: '控制台地址', value: runtime.consoleUrl, copyable: true }]
        : []),
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
    return {
      title: '云服务器',
      status,
      fields,
      actions: [
        { id: 'power_on', label: '开机' },
        { id: 'power_off', label: '关机' },
        { id: 'reboot', label: '重启', confirm: true },
        {
          id: 'reinstall',
          label: '重装系统',
          danger: true,
          confirm: true,
          params: [
            {
              name: 'os',
              label: '操作系统',
              type: 'select',
              required: true,
              options: [
                { label: 'Ubuntu 22.04', value: 'ubuntu-22.04' },
                { label: 'Debian 12', value: 'debian-12' },
                { label: 'CentOS 7', value: 'centos-7' },
                { label: 'Windows Server 2022', value: 'windows-2022' },
              ],
            },
          ],
        },
        {
          id: 'reset_password',
          label: '重置密码',
          confirm: true,
          params: [
            {
              name: 'password',
              label: '新密码',
              type: 'password',
              required: true,
              min: 8,
              maxLength: 64,
              placeholder: '至少 8 位，含大小写字母与数字',
            },
          ],
        },
        { id: 'vnc', label: '打开控制台（VNC）' },
      ],
    };
  },

  /**
   * 本平台托管的云服务器运维动作。
   *
   * 由于「本平台即上游」，动作只更新服务 runtime 的模拟状态（电源、系统、密码），
   * 不调用任何外部系统；返回 {@link ServiceActionResult} 供 store 合并 runtime 并透传
   * 展示字段（如重置后的密码）。外部上游（如 zjmf）由对应上游插件覆盖这些动作。
   */
  async executeAction(
    actionId: string,
    ctx: ProviderServiceContext,
    params?: Record<string, string>,
  ): Promise<ServiceActionResult> {
    const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
    switch (actionId) {
      case 'power_on':
        return { message: '已开机', runtime: { ...runtime, powerState: 'running' } };
      case 'power_off':
        return { message: '已关机', runtime: { ...runtime, powerState: 'stopped' } };
      case 'reboot':
        return { message: '已重启', runtime: { ...runtime, powerState: 'running' } };
      case 'reinstall': {
        const os = params?.['os'];
        if (!os) throw new PluginError('store.product.action_param_invalid', 400, '请选择操作系统');
        return {
          message: '系统重装已提交',
          runtime: { ...runtime, os, powerState: 'running' },
          fields: [{ label: '操作系统', value: os }],
        };
      }
      case 'reset_password': {
        const password = params?.['password'];
        if (!password || password.length < 8) {
          throw new PluginError('store.product.action_param_invalid', 400, '新密码至少 8 位');
        }
        return {
          message: '密码已重置',
          runtime: { ...runtime, passwordUpdatedAt: new Date().toISOString() },
          fields: [{ label: '新密码', value: password, secret: true, copyable: true }],
        };
      }
      case 'vnc': {
        // 平台前端 action 无回传通道，故把控制台地址落到 runtime，刷新后仍可在详情展示。
        const consoleUrl = 'about:blank#vnc-console';
        return {
          message: '控制台会话已就绪',
          url: consoleUrl,
          runtime: { ...runtime, consoleUrl },
        };
      }
      default:
        throw new PluginError('store.product.action_unsupported', 400, '不支持的运维动作');
    }
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
