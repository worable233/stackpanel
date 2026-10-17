import {
  EXTENSION_POINTS,
  computeCheckoutPrice,
  readCheckoutConfig,
  definePlugin,
  PluginError,
} from '@stackpanel/sdk';
import type {
  CheckoutConfigSchema,
  CheckoutPriceContext,
  CheckoutPriceResult,
  CheckoutSelection,
  FulfillmentProvider,
  ProductConfigField,
  ProductTypeProvider,
  ProvisionContext,
  ProvisionResult,
  ProviderServiceContext,
  ServiceActionResult,
  ServiceChangeInput,
  ServiceDetail,
  ServiceRenewalInput,
  ServiceResource,
  ServiceResourceKind,
} from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * 云服务器商品类型插件。
 *
 * 只定义「云服务器」这个商品类型的形态：类型配置字段（区域/规格/网络/镜像/计费）、
 * 后端校验 schema、以及「本平台即上游」的本地履约（占位/托管，不依赖任何外部上游）。
 * 商品可额外关联外部上游（如 zjmf）——由上游插件经 `upstream.product.source` 提供，
 * 本插件对具体上游零依赖。
 *
 * 配置矩阵：结账配置（`metadata.checkoutConfig`）支持分组、多档位、每档按周期定价、
 * 层级联动（`requires`）与条件显隐（`visibleWhen`）。本插件内置一份演示矩阵，
 * 供未显式配置的商品也能开箱体验。
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
    help: '商家侧展示与服务部署区域。',
    options: [
      { label: '华东', value: 'east-china' },
      { label: '华南', value: 'south-china' },
      { label: '华北', value: 'north-china' },
      { label: '西南', value: 'southwest-china' },
    ],
  },
  { name: 'specs.cpu', label: 'CPU（核）', type: 'number', min: 1, group: '规格' },
  { name: 'specs.memory', label: '内存（GB）', type: 'number', min: 1, group: '规格' },
  { name: 'specs.disk', label: '数据盘（GB）', type: 'number', min: 0, group: '规格' },
  { name: 'specs.bandwidth', label: '带宽（Mbps）', type: 'number', min: 1, group: '规格' },
  {
    name: 'network',
    label: '网络类型',
    type: 'select',
    options: [
      { label: '经典网络', value: 'classic' },
      { label: 'VPC', value: 'vpc' },
    ],
  },
  {
    name: 'image',
    label: '默认镜像',
    type: 'select',
    help: '结账时顾客可在镜像组内另选。',
    options: [
      { label: 'Ubuntu 22.04', value: 'ubuntu-22.04' },
      { label: 'Debian 12', value: 'debian-12' },
      { label: 'CentOS 7', value: 'centos-7' },
      { label: 'Windows Server 2022', value: 'windows-2022' },
    ],
  },
  {
    name: 'billingCycle',
    label: '计费周期',
    type: 'select',
    options: [
      { label: '月付', value: 'monthly' },
      { label: '年付', value: 'yearly' },
    ],
  },
  {
    name: 'contractMonths',
    label: '合约月数',
    type: 'number',
    min: 1,
    help: '仅在年付时需要填写。',
    visibleWhen: { field: 'billingCycle', equals: 'yearly' },
  },
  {
    name: 'backupEnabled',
    label: '启用备份',
    type: 'boolean',
    help: '开启后可在「我的服务」中创建备份。',
    group: '高级',
  },
];

/**
 * 内置演示配置矩阵：区域 → 线路（带宽）→ 规格（多档）→ 镜像（含收费镜像）。
 *
 * 展示配置矩阵的四项关键能力：
 *  - 分组（group）：位置 / 规格 / 镜像。
 *  - 多档位 + 每档按周期定价（choice.prices）。
 *  - 层级联动（choice.requires）：镜像仅在所选区域可用。
 *  - 条件显隐（option.visibleWhen）：仅 VPC 网络显示「弹性 IP 数」。
 */
const DEMO_CHECKOUT_CONFIG: CheckoutConfigSchema = {
  cycles: [
    { id: 'monthly', label: '月付', price: 6000, renewPrice: 6000, months: 1 },
    { id: 'yearly', label: '年付', price: 60000, renewPrice: 60000, months: 12 },
  ],
  options: [
    {
      id: 'region',
      label: '区域',
      type: 'select',
      group: '位置',
      required: true,
      choices: [
        { id: 'east-china', label: '华东', price: 0 },
        { id: 'south-china', label: '华南', price: 0 },
        { id: 'north-china', label: '华北', price: 0 },
      ],
    },
    {
      id: 'line',
      label: '线路',
      type: 'select',
      group: '位置',
      required: true,
      choices: [
        { id: 'bw-5', label: '带宽 5Mbps', prices: { monthly: 500, yearly: 5000 } },
        { id: 'bw-10', label: '带宽 10Mbps', prices: { monthly: 1000, yearly: 10000 } },
        { id: 'bw-20', label: '带宽 20Mbps', prices: { monthly: 2000, yearly: 20000 } },
      ],
    },
    {
      id: 'cpu',
      label: 'CPU',
      type: 'select',
      group: '规格',
      required: true,
      choices: [
        { id: 'cpu-2', label: '2 核', prices: { monthly: 1000, yearly: 10000 } },
        { id: 'cpu-4', label: '4 核', prices: { monthly: 2000, yearly: 20000 } },
        { id: 'cpu-8', label: '8 核', prices: { monthly: 4000, yearly: 40000 } },
      ],
    },
    {
      id: 'memory',
      label: '内存',
      type: 'select',
      group: '规格',
      required: true,
      choices: [
        { id: 'mem-4', label: '4 GB', prices: { monthly: 800, yearly: 8000 } },
        { id: 'mem-8', label: '8 GB', prices: { monthly: 1600, yearly: 16000 } },
        { id: 'mem-16', label: '16 GB', prices: { monthly: 3200, yearly: 32000 } },
      ],
    },
    {
      id: 'image',
      label: '镜像',
      type: 'select',
      group: '镜像',
      required: true,
      help: 'Windows 镜像可能仅在部分区域提供。',
      choices: [
        { id: 'ubuntu-22.04', label: 'Ubuntu 22.04', price: 0, requires: { region: ['east-china', 'south-china', 'north-china'] } },
        { id: 'debian-12', label: 'Debian 12', price: 0, requires: { region: ['east-china', 'south-china', 'north-china'] } },
        {
          id: 'windows-2022',
          label: 'Windows Server 2022',
          prices: { monthly: 500, yearly: 5000 },
          // 收费镜像：一次性授权费，不计入续费。
          recurring: false,
          requires: { region: ['east-china', 'north-china'] },
        },
      ],
    },
    {
      id: 'elasticIp',
      label: '弹性 IP 数',
      type: 'quantity',
      group: '网络',
      unit: '个',
      min: 0,
      max: 5,
      choices: [{ id: 'eip', label: '弹性 IP', prices: { monthly: 300, yearly: 3000 } }],
      visibleWhen: { field: 'network', equals: 'vpc' },
    },
    {
      id: 'network',
      label: '网络类型',
      type: 'select',
      group: '网络',
      choices: [
        { id: 'classic', label: '经典网络', price: 0 },
        { id: 'vpc', label: 'VPC', price: 0 },
      ],
      defaultChoice: 'classic',
    },
  ],
};

/** 商品若未显式配置 checkoutConfig，则回退到内置演示矩阵（开箱体验）。 */
function resolveSchema(metadata: unknown): CheckoutConfigSchema {
  return readCheckoutConfig(metadata) ?? DEMO_CHECKOUT_CONFIG;
}

/** 从 runtime 读取已购配置选择（store 写入 runtime.config）。 */
function readRuntimeSelection(runtime: unknown): CheckoutSelection | undefined {
  const bag = (runtime ?? {}) as Record<string, unknown>;
  const config = bag['config'];
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    return config as CheckoutSelection;
  }
  // 兼容：早期版本写入 runtime.checkoutConfig。
  const legacy = bag['checkoutConfig'];
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    const l = legacy as { cycle?: string; selections?: Record<string, string | number> };
    return {
      ...(l.cycle ? { cycle: l.cycle } : {}),
      ...(l.selections ? { selections: l.selections } : {}),
    };
  }
  return undefined;
}

/** 把结账选择中的档位标签拼成人类可读摘要（无 summary 时用）。 */
function selectionSummary(schema: CheckoutConfigSchema, config: CheckoutSelection): string {
  const parts: string[] = [];
  const cycle = schema.cycles.find((candidate) => candidate.id === config.cycle);
  if (cycle) parts.push(cycle.label);
  for (const option of schema.options) {
    const raw = config.selections?.[option.id];
    if (raw === undefined || raw === null || raw === '') continue;
    if (option.type === 'quantity') {
      parts.push(`${option.label} ${raw}${option.unit ?? ''}`);
      continue;
    }
    const choice = option.choices?.find((candidate) => candidate.id === raw);
    if (choice) parts.push(choice.label);
  }
  return parts.join(' · ');
}

/** 本平台即上游的本地履约：不调用外部，按商品配置生成交付物。 */
const localProvider: FulfillmentProvider = {
  id: 'store-product-server',
  name: '云服务器（本平台）',
  fulfillmentTypes: ['cloud_server'],

  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    const metadata = (ctx.product.metadata ?? {}) as Record<string, unknown>;
    const schema = resolveSchema(metadata);
    const summary = ctx.config ? selectionSummary(schema, ctx.config) : undefined;
    return {
      status: 'ACTIVE',
      providerServiceId: null,
      runtime: {
        status: 'ACTIVE',
        powerState: 'running',
        ...(typeof metadata.specs === 'object' && metadata.specs !== null
          ? { specs: metadata.specs }
          : {}),
        ...(typeof metadata.region === 'string' ? { region: metadata.region } : {}),
        ...(typeof metadata.image === 'string' ? { os: metadata.image } : {}),
        ...(typeof metadata.network === 'string' ? { network: metadata.network } : {}),
        ...(summary ? { configSummary: summary } : {}),
        // 资源面板种子：默认无附加磁盘/快照/备份。
        disks: [],
        snapshots: [],
        backups: [],
        firewallRules: [],
        flowPackets: [],
      },
      message: '云服务器已开通（本平台托管）',
    };
  },

  /** 本地可配置商品：按 metadata.checkoutConfig（或内置演示矩阵）静态计价。 */
  async calculateCheckoutPrice(ctx: CheckoutPriceContext): Promise<CheckoutPriceResult> {
    const schema = resolveSchema(ctx.product.metadata);
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
      ...(typeof runtime.network === 'string' ? [{ label: '网络', value: runtime.network }] : []),
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
    if (typeof runtime.configSummary === 'string') {
      fields.push({ label: '配置', value: runtime.configSummary });
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
      ],
    };
  },

  /**
   * 本平台托管的云服务器运维动作：**仅更新本地 runtime 状态，不触达真实基础设施**。
   *
   * 审计 #1 边界：这些动作（电源/重装/改密）只是本地「交付记录」，不等于完成真实
   * 运维；真实运维必须由外部云 provider 的 `productType` 实现。VNC 无真实实现，
   * 因此既不出现在 `actions()` 里，也会显式拒绝（见下方 `vnc` 分支）。
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
        // 本地托管模拟不提供真实远程控制台。以前这里返回 `about:blank#vnc-console`
        // 占位地址，会被当成可用的运维闭环（审计 #1）。宁可直接拒绝，也不伪造。
        throw new PluginError(
          'store.product.action_unsupported',
          501,
          '本地托管实例未接入真实 VNC 控制台，请配置上游云 provider 后再使用',
        );
      }
      default:
        throw new PluginError('store.product.action_unsupported', 400, '不支持的运维动作');
    }
  },

  /** 升配/降配：把新配置写回 runtime 的 specs 与 config 摘要。 */
  async changePackage(
    ctx: ProviderServiceContext,
    change: ServiceChangeInput,
  ): Promise<ServiceActionResult> {
    const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
    const selection = change.config ?? readRuntimeSelection(runtime);
    const summary = selection ? selectionSummary(DEMO_CHECKOUT_CONFIG, selection) : undefined;
    const specs = deriveSpecs(selection);
    return {
      message: '配置变更已生效',
      runtime: {
        ...runtime,
        ...(Object.keys(specs).length > 0 ? { specs: { ...(runtime.specs ?? {}), ...specs } } : {}),
        ...(summary ? { configSummary: summary } : {}),
      },
    };
  },

  /** 换商品：记录目标商品；本平台托管无外部系统可言，仅回执。 */
  async changeProduct(_ctx: ProviderServiceContext, change: ServiceChangeInput): Promise<ServiceActionResult> {
    return { message: `商品已切换${change.targetProductId ? `：${change.targetProductId}` : ''}` };
  },

  /** 续费回调：本平台无需外部动作，仅回执（真实上游会在此同步）。 */
  async renew(_ctx: ProviderServiceContext, info: ServiceRenewalInput): Promise<ServiceActionResult> {
    return { message: `已续费至 ${info.newExpiresAt}` };
  },

  /** 转移所有权：本平台直接换主，无外部系统。 */
  async changeOwner(ctx: ProviderServiceContext, targetUserId: string): Promise<ServiceActionResult> {
    return { message: `所有权已转移至 ${targetUserId}`, runtime: { ...(ctx.service.runtime as object) } };
  },

  /** 声明增值运维资源种类。 */
  async listResourceKinds(): Promise<ServiceResourceKind[]> {
    return [
      {
        id: 'disk',
        label: '数据盘',
        creatable: true,
        createParams: [
          { name: 'size', label: '容量（GB）', type: 'number', required: true, min: 10, max: 2000 },
          { name: 'type', label: '盘类型', type: 'select', options: [
            { label: 'SSD', value: 'ssd' },
            { label: '高效云盘', value: 'cloud' },
          ] },
        ],
        columns: [
          { key: 'size', label: '容量' },
          { key: 'type', label: '类型' },
          { key: 'status', label: '状态' },
        ],
        rowActions: [
          {
            id: 'resize',
            label: '扩容',
            confirm: true,
            params: [{ name: 'size', label: '新容量（GB）', type: 'number', required: true, min: 1 }],
          },
          { id: 'delete', label: '卸载并删除', danger: true, confirm: true },
        ],
      },
      {
        id: 'snapshot',
        label: '快照',
        creatable: true,
        createParams: [{ name: 'name', label: '快照名称', type: 'text', required: true, maxLength: 64 }],
        columns: [
          { key: 'name', label: '名称' },
          { key: 'createdAt', label: '创建时间' },
        ],
        rowActions: [
          { id: 'restore', label: '恢复', danger: true, confirm: true },
          { id: 'delete', label: '删除', danger: true, confirm: true },
        ],
      },
      {
        id: 'backup',
        label: '备份',
        creatable: true,
        createParams: [{ name: 'name', label: '备份名称', type: 'text', required: true, maxLength: 64 }],
        columns: [
          { key: 'name', label: '名称' },
          { key: 'createdAt', label: '创建时间' },
        ],
        rowActions: [
          { id: 'restore', label: '恢复', danger: true, confirm: true },
          { id: 'delete', label: '删除', danger: true, confirm: true },
        ],
      },
      {
        id: 'firewall',
        label: '安全组规则',
        creatable: true,
        createParams: [
          { name: 'protocol', label: '协议', type: 'select', required: true, options: [
            { label: 'TCP', value: 'tcp' },
            { label: 'UDP', value: 'udp' },
            { label: 'ICMP', value: 'icmp' },
          ] },
          { name: 'port', label: '端口', type: 'text', required: true, maxLength: 32 },
          { name: 'cidr', label: '来源 CIDR', type: 'text', maxLength: 64 },
        ],
        columns: [
          { key: 'protocol', label: '协议' },
          { key: 'port', label: '端口' },
          { key: 'cidr', label: '来源' },
        ],
        rowActions: [{ id: 'delete', label: '删除', danger: true, confirm: true }],
      },
      {
        id: 'flowPacket',
        label: '流量包',
        creatable: true,
        createParams: [{ name: 'size', label: '流量（GB）', type: 'number', required: true, min: 1 }],
        columns: [
          { key: 'size', label: '流量' },
          { key: 'createdAt', label: '购买时间' },
        ],
        visibleWhen: { field: 'network', equals: 'vpc' },
      },
    ];
  },

  async listResources(ctx: ProviderServiceContext, kind: string): Promise<ServiceResource[]> {
    const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
    const rows = runtime[kind];
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const record = (row ?? {}) as Record<string, unknown>;
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(record)) {
        if (key === 'id') continue;
        fields[key] = String(value);
      }
      return { id: typeof record.id === 'string' ? record.id : cryptoRandomId(), fields };
    });
  },

  async createResource(
    ctx: ProviderServiceContext,
    kind: string,
    params?: Record<string, string>,
  ): Promise<ServiceActionResult> {
    const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(runtime[kind]) ? (runtime[kind] as unknown[]) : [];
    const entry: Record<string, unknown> = {
      id: cryptoRandomId(),
      status: 'available',
      createdAt: new Date().toISOString(),
      ...(params ?? {}),
    };
    return {
      message: '已创建',
      runtime: { ...runtime, [kind]: [...rows, entry] },
    };
  },

  async runResourceAction(
    ctx: ProviderServiceContext,
    kind: string,
    resourceId: string,
    actionId: string,
    params?: Record<string, string>,
  ): Promise<ServiceActionResult> {
    const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(runtime[kind]) ? (runtime[kind] as Record<string, unknown>[]) : [];
    if (actionId === 'delete') {
      return {
        message: '已删除',
        runtime: { ...runtime, [kind]: rows.filter((row) => row.id !== resourceId) },
      };
    }
    const updated = rows.map((row) =>
      row.id === resourceId ? { ...row, ...(params ?? {}), status: 'available' } : row,
    );
    return { message: '操作已提交', runtime: { ...runtime, [kind]: updated } };
  },
};

/** 从结账选择推导展示用规格（演示）。 */
function deriveSpecs(selection: CheckoutSelection | undefined): Record<string, string> {
  if (!selection?.selections) return {};
  const specs: Record<string, string> = {};
  const map: Record<string, string> = {
    cpu: 'cpu',
    memory: 'memory',
    line: 'bandwidth',
    image: 'os',
    region: 'region',
  };
  for (const [key, label] of Object.entries(map)) {
    const value = selection.selections[key];
    if (value !== undefined) specs[label] = String(value);
  }
  return specs;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

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
    version: '0.2.0',
    description:
      '云服务器商品类型：类型配置字段 + 配置矩阵（分组/多档/联动/每档周期价）+ 本平台即上游的本地履约。可关联外部上游。',
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
