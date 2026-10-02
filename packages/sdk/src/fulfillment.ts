import type { z } from 'zod';
import type { PluginSecrets } from './plugin.js';

/**
 * 履约/交付物 SPI（Fulfillment SPI）。
 *
 * 商店插件（core）只负责「通用履约骨架」：ServiceInstance 生命周期、异步任务队列、
 * 按 `product.fulfillmentType` 分发、以及用户「我的服务」列表/详情容器。
 * 它不关心具体商品长什么样。每个商品类型由一个独立插件实现本 SPI 并注册，
 * 从而支持云服务器、发卡、授权、会员、实物、赞助、API token、流量卡等全品类。
 *
 * 外部提供方（如智简魔方）只实现本接口的「provision / 生命周期 / 只读展示」能力，
 * 我们统一读取并展示，数据在外部。
 */

/** 内建履约类型。插件可声明自定义字符串类型。 */
export type FulfillmentType =
  | 'upstream_service' // 外部开通（云服务器等）
  | 'card' // 发卡授权
  | 'instant' // 即时发放（授权/兑换码）
  | 'api_token' // 大模型 API token / 额度
  | 'membership' // 会员时长
  | 'physical' // 实物（淘宝/京东式履约）
  | 'donation' // 赞助（仅记录）
  | 'topup' // 流量卡/充值
  | string;

/** 交付物状态。 */
export type ServiceStatus =
  'PENDING_PROVISION' | 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED' | 'FAILED';

/** 履约触发时提供给提供方的上下文（含商品快照与提供方密钥访问）。 */
export interface ProvisionContext {
  orderId: string;
  userId: string;
  productId: string;
  product: {
    id: string;
    name: string;
    price: number;
    currency: string;
    metadata: unknown;
    providerId: string | null;
    providerProductId: string | null;
  };
  quantity: number;
  /** 顾客在结算时选择的配置（可配置商品）。 */
  config?: CheckoutSelection;
  /** 提供方插件自身的加密密钥存储。 */
  secrets: PluginSecrets;
}

/** 提供方履约结果。凭证由提供方插件自行加密存入其 secrets，并返回 credentialsRef 引用。 */
export interface ProvisionResult {
  status: 'ACTIVE' | 'PENDING' | 'FAILED';
  /** 提供方侧的服务/实例 id（如魔方服务 id）。 */
  providerServiceId?: string | null;
  /**
   * 凭证引用。约定：提供方写入 {@link ProvisionContext.secrets}（调用方传入的、
   * store 命名空间下的密钥存储），后续 getDetail 时从 {@link ProviderServiceContext.secrets}
   * 以同一引用读取。core 会原样写到 ServiceInstance.credentialsRef。
   */
  credentialsRef?: string | null;
  /**
   * 兼容形态：明文凭证，core 会加密存储（不推荐，建议用 credentialsRef）。
   */
  credentials?: Record<string, string>;
  /** 可缓存的展示数据（IP、规格、状态等）。 */
  runtime?: Record<string, unknown>;
  message?: string;
}

/** 提供方对某个已交付服务的只读上下文。 */
export interface ProviderServiceContext {
  service: {
    id: string;
    providerId: string | null;
    providerServiceId: string | null;
    runtime: unknown;
    credentialsRef: string | null;
    userId: string;
    orderId: string | null;
    productId: string;
    status: string;
    /** 商品名，供提供方在缺少上游标题时回退展示。 */
    productName?: string;
  };
  secrets: PluginSecrets;
}

/** 服务详情里的一个字段（ROOT 账户、IPv4、状态等）。secret 字段需打码/隐藏明文。 */
export interface ServiceDetailField {
  label: string;
  value: string;
  secret?: boolean;
  copyable?: boolean;
}

/** 服务可执行的运维动作（开机/关机/重启）。 */
export interface ServiceAction {
  id: string;
  label: string;
  danger?: boolean;
  confirm?: boolean;
}

/** 提供方返回的服务详情。 */
export interface ServiceDetail {
  title?: string;
  status?: ServiceStatus;
  statusLabel?: string;
  fields: ServiceDetailField[];
  actions?: ServiceAction[];
}

/** 时序点：t 为 epoch 毫秒，v 为数值。 */
export interface MetricPoint {
  t: number;
  v: number;
}

/** 一条监控序列（CPU 占用率、内存占用率等）。 */
export interface MetricSeries {
  id: string;
  label: string;
  unit: string; // '%' | 'MB' | ...
  points: MetricPoint[];
  color?: string;
}

/**
 * 履约提供方契约。外部源（智简魔方等）实现本接口并注册到
 * `EXTENSION_POINTS.fulfillmentProvider`，core 统一读取与展示。
 */
export interface FulfillmentProvider {
  readonly id: string;
  readonly name: string;
  readonly fulfillmentTypes: FulfillmentType[];

  /** 把「已付款商品」转化为交付物（云服务器开通/发卡配卡/token 生成等）。 */
  provision(ctx: ProvisionContext): Promise<ProvisionResult>;

  /** 按顾客配置计算结算价格（可配置商品）。未实现则回退到商品静态价格。 */
  calculateCheckoutPrice?(ctx: CheckoutPriceContext): Promise<CheckoutPriceResult>;

  /** 生命周期控制（可选）。 */
  suspend?(ctx: ProviderServiceContext): Promise<void>;
  resume?(ctx: ProviderServiceContext): Promise<void>;
  terminate?(ctx: ProviderServiceContext): Promise<void>;

  /** 读取并展示服务详情（可选；无实现则回退到缓存的 runtime）。 */
  getDetail?(ctx: ProviderServiceContext): Promise<ServiceDetail>;
  /** 读取监控时序（CPU/内存等）。 */
  getMetrics?(ctx: ProviderServiceContext): Promise<MetricSeries[]>;
  /** 执行运维动作（开机/关机/重启）。 */
  executeAction?(actionId: string, ctx: ProviderServiceContext): Promise<void>;
}

/**
 * 商品类型提供方（商品类型插件）。
 *
 * 每个商品类型（云服务器、发卡/兑换码、会员…）由一个独立插件实现本接口并注册到
 * `EXTENSION_POINTS.productType`。它同时负责两件事：
 *  1. 类型定义：`label` 展示名、`fulfillmentTypes` 认领的类型 key、
 *     `configFields` 声明管理端「类型配置表单」字段（store 通用渲染）、
 *     `configSchema` 校验该类型商品 `metadata` 中的配置。
 *  2. 交付：继承 {@link FulfillmentProvider}（本平台即上游的本地履约/占位交付）。
 *
 * 注意：商品类型与「上游」正交。外部上游（如 zjmf）通过
 * `EXTENSION_POINTS.upstreamProductSource` 提供「可关联的上游商品」，
 * 商品可关联也可不关联；类型插件本身不依赖任何上游。
 */
export interface ProductTypeProvider extends FulfillmentProvider {
  /** 类型展示名，如「云服务器」「发卡」。 */
  label: string;
  /** 管理端类型配置表单的字段声明（store 通用渲染，存到商品 metadata）。 */
  configFields?: ProductConfigField[];
  /** 校验该类型商品 `metadata` 的配置部分（创建/编辑商品时后端校验）。 */
  configSchema?: z.ZodType<Record<string, unknown>>;
}

/** 类型配置表单的一个字段声明（数据驱动，store 通用渲染）。 */
export interface ProductConfigField {
  /** 存到 metadata 的键，支持点路径（如 `specs.cpu`）。 */
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'boolean';
  required?: boolean | undefined;
  placeholder?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
  maxLength?: number | undefined;
  options?: Array<{ label: string; value: string }> | undefined;
}

/* ------------------------- 可配置商品（结账配置） ------------------------- */

/**
 * 商品级「结账配置」schema（存在 `product.metadata.checkoutConfig`）。
 *
 * 可配置商品在结账时让顾客选择计费周期 + 若干配置项（下拉/数量），每项影响价格。
 * store 负责渲染与校验、把选择传给履约提供方；具体计价由提供方实现
 * {@link FulfillmentProvider.calculateCheckoutPrice}（上游走 `get_total`，
 * 本地类型插件用 {@link computeCheckoutPrice} 从 schema 静态计算）。
 */
export interface CheckoutConfigSchema {
  /** 可选计费周期（至少 1 个）。 */
  cycles: CheckoutBillingCycle[];
  /** 结账时渲染的配置项（可为空 = 仅选周期）。 */
  options: CheckoutConfigOption[];
}

/** 一个计费周期。`id` 对上游是 billingcycle 键（monthly/quarterly…），本地可用 onetime/自定义。 */
export interface CheckoutBillingCycle {
  id: string;
  /** 展示名，如「月付」「一次性」。 */
  label: string;
  /** 该周期基础价（minor units）。 */
  price: number;
  /** 续费价（可选，默认等于 price）。 */
  renewPrice?: number;
}

/** 结账页渲染的一个配置项。 */
export interface CheckoutConfigOption {
  /** 稳定 id。对上游是 configoption 的配置项 id。 */
  id: string;
  label: string;
  type: 'select' | 'quantity';
  /** 数量类型时的单位（核/GB/Mbps…）。 */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  /**
   * 选项。select 类型 = 每个候选项；quantity 类型 = 计费档位（通常 1 条，price=单位价）。
   * 上游商品的价格可能由上游权威计算（此处可为空，价格走 calculateCheckoutPrice）。
   */
  choices?: CheckoutOptionChoice[];
}

/** 一个可选值/档位。 */
export interface CheckoutOptionChoice {
  id: string;
  label: string;
  /** 附加价（minor）：select=选中增量；quantity=每单位价格。 */
  price?: number;
  qtyMin?: number;
  qtyMax?: number;
}

/** 顾客在结账时提交的选择：cycle=周期 id；selections=配置项 id → 选项 id（select）或数量（quantity）。 */
export interface CheckoutSelection {
  cycle?: string;
  selections?: Record<string, string | number>;
  /** 人类可读的配置摘要（如「CPU:4核 · 内存:8G」），用于订单明细展示。 */
  summary?: string;
}

/** 提供方计价上下文。 */
export interface CheckoutPriceContext {
  product: {
    id: string;
    price: number;
    currency: string;
    metadata: unknown;
    providerProductId?: string | null;
  };
  quantity: number;
  config: CheckoutSelection;
}

/** 提供方计价结果。 */
export interface CheckoutPriceResult {
  /** 单价（minor units，含配置增量，未乘 quantity）。 */
  price: number;
  renewPrice?: number;
  /** 逐项明细，用于页面展示。 */
  breakdown?: Array<{ label: string; value: string; price?: number }>;
  summary?: string;
}

/** 从商品 metadata 读取 checkoutConfig（无则返回 null）。 */
export function readCheckoutConfig(metadata: unknown): CheckoutConfigSchema | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const config = (metadata as Record<string, unknown>)['checkoutConfig'];
  if (config === null || typeof config !== 'object') return null;
  const candidate = config as Partial<CheckoutConfigSchema>;
  if (!Array.isArray(candidate.cycles) || candidate.cycles.length === 0) return null;
  return {
    cycles: candidate.cycles.filter(
      (cycle): cycle is CheckoutBillingCycle =>
        cycle !== null &&
        typeof cycle === 'object' &&
        typeof cycle.id === 'string' &&
        typeof cycle.price === 'number',
    ),
    options: Array.isArray(candidate.options) ? (candidate.options as CheckoutConfigOption[]) : [],
  };
}

/**
 * 本地计价：从 schema + 选择计算单价（minor units）。不依赖上游。
 * - select：`price` 为该选项的附加价增量。
 * - quantity：`price` 为该选项的单位价，按选择数量累加。
 * 若提供方实现了 `calculateCheckoutPrice`，应由其返回权威价；本函数是回退/本地类型用。
 */
export function computeCheckoutPrice(
  schema: CheckoutConfigSchema,
  config: CheckoutSelection,
): CheckoutPriceResult {
  const cycleId = config.cycle ?? schema.cycles[0]?.id ?? '';
  const cycle = schema.cycles.find((candidate) => candidate.id === cycleId) ?? schema.cycles[0];
  let price = cycle?.price ?? 0;
  const breakdown: CheckoutPriceResult['breakdown'] = [];
  if (cycle) breakdown.push({ label: cycle.label, value: cycle.label, price: cycle.price });
  const selections = config.selections ?? {};
  for (const option of schema.options) {
    const raw = selections[option.id];
    if (raw === undefined || raw === null || raw === '') continue;
    if (option.type === 'quantity') {
      const qty = typeof raw === 'number' ? raw : Number(raw);
      const choice = option.choices?.[0];
      const unit = choice?.price ?? 0;
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const line = Math.round(unit * qty);
      price += line;
      breakdown.push({
        label: option.label,
        value: `${qty}${option.unit ? ` ${option.unit}` : ''}`,
        price: line,
      });
      continue;
    }
    const choice = option.choices?.find((candidate) => candidate.id === raw);
    if (!choice) continue;
    const line = choice.price ?? 0;
    price += line;
    breakdown.push({ label: option.label, value: choice.label, price: line });
  }
  return {
    price,
    renewPrice: cycle?.renewPrice ?? cycle?.price ?? price,
    breakdown,
    summary: breakdown.map((item) => `${item.label}:${item.value}`).join(' · '),
  };
}
