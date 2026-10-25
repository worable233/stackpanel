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
  /** Stable per-unit fulfillment identity. Omitted by legacy callers. */
  fulfillmentId?: string;
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
  /**
   * 商店将写入服务实例的初始到期时间（ISO 8601），`null` = 永久/非周期商品。
   *
   * 由 store 按商品的计费周期统一推算后传入，提供方**不要**自己再算一遍月数：
   * 两套周期算法必然漂移，会员类权益的到期时间会与商店展示的到期时间不一致。
   */
  expiresAt?: string | null;
  /** 提供方插件自身的加密密钥存储。 */
  secrets: PluginSecrets;
  /** Persist the upstream identity before any payment or subsequent remote call. */
  checkpoint?: (result: ProvisionResult) => Promise<void>;
  /** Explicit admin recovery of a recorded unpaid invoice; never create another order. */
  resumePayment?: boolean;
  /** Recovery generation, created only after server-side cancellation verification. */
  recoveryGeneration?: number;
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
    /** 服务实例的到期时间（ISO 8601）；`null` = 永久/无到期。 */
    expiresAt?: string | null;
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

/**
 * 运维动作的一个输入参数声明。提供方（商品类型/上游插件）据此告诉前端如何
 * 渲染表单，并在 {@link FulfillmentProvider.executeAction} 中以同名键回传用户输入。
 */
export interface ServiceActionParam {
  name: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'textarea';
  required?: boolean;
  default?: string | number;
  /** type=select 时的候选值。 */
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  maxLength?: number;
  placeholder?: string;
}

/** 服务可执行的运维动作（开机/关机/重启/重装/重置密码等）。 */
export interface ServiceAction {
  id: string;
  label: string;
  danger?: boolean;
  confirm?: boolean;
  /** 需要用户填写的参数；缺省表示无参动作。 */
  params?: ServiceActionParam[];
}

/**
 * 运维动作的执行结果。多数动作无需返回内容；当动作产生可展示数据（如重置后的
 * 新密码、控制台地址）或需要跳转时，由提供方返回本结构供 store 透传给前端。
 *
 * 注意：store 控制台（`store.service-action`）目前**不渲染** `message` / `fields` / `url`，
 * 成功只给一条由 store 自己 catalog 决定的回执，实际变化由实例详情刷新体现。
 * 所以这三个字段不要用来承载用户可见文案：界面文案永远归渲染方（ADR-0016 §6），
 * 后端只描述「发生了什么」，不要描述「该怎么措辞」。
 */
export interface ServiceActionResult {
  /**
   * @deprecated 仅供日志/排障。没有任何前端消费它（控制台不渲染），写在这里的中文
   * 也不会出现在界面上；需要用户看到的文案请交给渲染方的 catalog。
   */
  message?: string;
  /** 执行后返回的展示字段（如新密码、一次性控制台令牌）。当前无消费方。 */
  fields?: ServiceDetailField[];
  /** 需要打开的地址（如 VNC / 控制台 URL）。当前无消费方。 */
  url?: string;
  /**
   * 需要合并回服务 runtime 的补丁（如重装后的操作系统、电源状态）。
   * store 会浅合并到 `ServiceInstance.runtime` 并刷新详情。
   */
  runtime?: Record<string, unknown>;
}

/** 提供方返回的服务详情。 */
export interface ServiceDetail {
  /** Authoritative upstream dates; missing dates must not be invented locally. */
  provisionedAt?: string | null;
  expiresAt?: string | null;
  title?: string;
  status?: ServiceStatus;
  statusLabel?: string;
  fields: ServiceDetailField[];
  actions?: ServiceAction[];
}

/**
 * 一种「服务子资源」种类（磁盘/快照/备份/IP/安全组/流量包…）的声明。
 *
 * 提供方只做声明，商店通用渲染「资源面板」：列表 + 新建 + 行内动作。
 * 该抽象让增值运维能力可纯插件扩展，商店对具体资源类型零耦合。
 */
export interface ServiceResourceKind {
  id: string;
  label: string;
  /** 是否支持新建（提供 createParams 时生效）。 */
  creatable?: boolean;
  /** 新建表单参数（复用 {@link ServiceActionParam}）。 */
  createParams?: ServiceActionParam[];
  /** 列表展示列。 */
  columns?: Array<{ key: string; label: string }>;
  /** 行内可执行动作（扩容/挂载/删除/恢复…）。 */
  rowActions?: ServiceAction[];
  /** 条件显隐：相对服务 runtime 的字段值（如仅 VPC 网络显示 NAT）。 */
  visibleWhen?: { field: string; equals?: unknown; in?: readonly unknown[] };
}

/** 服务子资源列表中的一行。 */
export interface ServiceResource {
  id: string;
  /** 列 key → 展示值（与 {@link ServiceResourceKind.columns} 对应）。 */
  fields: Record<string, string>;
  /** 本行实际可用的动作（可裁剪 `rowActions`）。 */
  actions?: ServiceAction[];
}

/** 服务配置变更（升配/降配/换商品）的入参。 */
export interface ServiceChangeInput {
  /** 目标配置选择（升配降配用）。 */
  config?: CheckoutSelection;
  /** 目标商品 id（换商品用）。 */
  targetProductId?: string;
  targetProviderProductId?: string | null;
}

/** 续费回调入参。 */
export interface ServiceRenewalInput {
  newExpiresAt: string;
  months: number;
  selection?: CheckoutSelection;
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

  /** Read-only verification of every original request. No cancellation/payment permitted. */
  verifyCancelledProvision?(ctx: ProvisionContext): Promise<{
    checkedAt: string;
    sourceId: string;
    requests: Array<{ reference: string; invoiceId: string; serviceIds: string[] }>;
  }>;

  /** 按顾客配置计算结算价格（可配置商品）。未实现则回退到商品静态价格。 */
  calculateCheckoutPrice?(ctx: CheckoutPriceContext): Promise<CheckoutPriceResult>;

  /** 生命周期控制（可选）。 */
  suspend?(ctx: ProviderServiceContext): Promise<void>;
  resume?(ctx: ProviderServiceContext): Promise<void>;
  terminate?(ctx: ProviderServiceContext): Promise<void>;

  /**
   * 续费回调（可选）：store 已推进到期时间后通知提供方（如上游需同步续费）。
   * 尽力而为——失败不阻断续费，由 store 记日志。
   */
  renew?(
    ctx: ProviderServiceContext,
    info: ServiceRenewalInput,
  ): Promise<ServiceActionResult | void>;

  /**
   * 变更配置（升配/降配，可选）：按新的 {@link CheckoutSelection} 调整实例规格。
   * 返回的 `runtime` 会合并回服务实例。
   */
  changePackage?(
    ctx: ProviderServiceContext,
    change: ServiceChangeInput,
  ): Promise<ServiceActionResult | void>;

  /** 换商品（可选）。 */
  changeProduct?(
    ctx: ProviderServiceContext,
    change: ServiceChangeInput,
  ): Promise<ServiceActionResult | void>;

  /**
   * 变更差价试算（可选）：升配/降配下单前的差价（minor units）。
   * 缺省由 store 用 checkoutConfig 差额估算；上游（如 zjmf）以权威试算为准。
   * `service` 为被变更服务的只读标识（上游试算需要其 providerServiceId）。
   */
  calculateChangePrice?(
    ctx: CheckoutPriceContext & {
      from?: CheckoutSelection;
      service?: ProviderServiceContext['service'];
    },
  ): Promise<CheckoutPriceResult>;

  /** 转移所有权（可选，管理员动作，走审批流）。 */
  changeOwner?(
    ctx: ProviderServiceContext,
    targetUserId: string,
  ): Promise<ServiceActionResult | void>;

  /** 声明可用的服务子资源种类（增值运维：磁盘/快照/备份/网络/流量包…）。 */
  listResourceKinds?(ctx: ProviderServiceContext): Promise<ServiceResourceKind[]>;

  /** 列出某类子资源。 */
  listResources?(ctx: ProviderServiceContext, kind: string): Promise<ServiceResource[]>;

  /** 新建子资源。 */
  createResource?(
    ctx: ProviderServiceContext,
    kind: string,
    params?: Record<string, string>,
  ): Promise<ServiceActionResult>;

  /** 对某个子资源执行行内动作（扩容/挂载/删除/恢复…）。 */
  runResourceAction?(
    ctx: ProviderServiceContext,
    kind: string,
    resourceId: string,
    actionId: string,
    params?: Record<string, string>,
  ): Promise<ServiceActionResult>;

  /** 读取并展示服务详情（可选；无实现则回退到缓存的 runtime）。 */
  getDetail?(ctx: ProviderServiceContext): Promise<ServiceDetail>;
  /** 读取监控时序（CPU/内存等）。 */
  getMetrics?(ctx: ProviderServiceContext): Promise<MetricSeries[]>;
  /**
   * 执行运维动作（开机/关机/重启/重装/重置密码等）。
   * `params` 为 {@link ServiceAction.params} 声明并由用户在表单填写的键值；
   * 返回 {@link ServiceActionResult} 可携带展示数据或跳转地址。
   */
  executeAction?(
    actionId: string,
    ctx: ProviderServiceContext,
    params?: Record<string, string>,
  ): Promise<ServiceActionResult | void>;
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

/** 类型配置表单控件的种类（数据驱动，store 通用渲染）。 */
export type ProductConfigFieldType =
  'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'boolean' | 'tags' | 'json';

/**
 * 条件显隐：仅当同组内 `field`（点路径）的当前值满足条件时才展示本字段。
 * `equals` 精确匹配；`in` 任一命中；两者都缺省表示「非空即显示」。
 */
export interface ProductConfigVisibility {
  field: string;
  equals?: unknown;
  in?: readonly unknown[] | undefined;
}

/**
 * 类型配置表单的一个字段声明（数据驱动，store 通用渲染）。
 *
 * 这是一个可递归的结构：`fields` 用于「分组」（不带 `repeat`）或「重复子表单」
 * （带 `repeat`，落库为数组）。类型插件只用声明式描述，store 负责渲染与归集，
 * 不引入任何插件前端代码（保持商店对类型零耦合）。
 */
export interface ProductConfigField {
  /** 存到 metadata 的键，支持点路径（如 `specs.cpu`）。分组/重复项时为其字段名。 */
  name: string;
  label: string;
  type: ProductConfigFieldType | 'group' | 'repeat';
  required?: boolean | undefined;
  placeholder?: string | undefined;
  /** 字段下方的说明文案（可选）。 */
  help?: string | undefined;
  /** 新商品时的默认值（可选）。 */
  defaultValue?: unknown;
  min?: number | undefined;
  max?: number | undefined;
  maxLength?: number | undefined;
  /** select / multiselect 的候选项。 */
  options?: Array<{ label: string; value: string }> | undefined;
  /**
   * 动态候选项来源：由商店在聚合商品类型时解析成 {@link options}。
   *
   * 类型插件只能声明静态 options，而权限组这类数据是运行期产生的。声明来源而
   * 非让插件自己查内核，既保持插件无 DB 访问，也保证候选项与当前权限组一致。
   * `permissionGroups` = 平台全部权限组（label 附带折扣）。
   */
  optionsSource?: 'permissionGroups' | undefined;
  /** 条件显隐（相对同一表单作用域内的兄弟字段）。 */
  visibleWhen?: ProductConfigVisibility | undefined;
  /** 分组名（同名的字段在 UI 上归入一个分组卡片）。 */
  group?: string | undefined;
  /** 布局列数（1 或 2，缺省 2）。 */
  columns?: 1 | 2 | undefined;
  /** type=group/repeat 时的子字段声明；repeat 时落库为数组。 */
  fields?: ProductConfigField[] | undefined;
  /** repeat 子表单中「新增一项」的按钮文案。 */
  itemLabel?: string | undefined;
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
  /** 该周期时长（月）。用于续费推算新到期时间；缺省按 1 个月处理。 */
  months?: number;
}

/**
 * 结账配置的条件显隐/联动条件（相对其它配置项或周期的当前选择）。
 * `equals` 精确匹配、`in` 任一命中；两者都缺省表示「非空即显示」。
 */
export interface CheckoutVisibility {
  /** 目标配置项 id，或特殊值 `cycle`（计费周期 id）。 */
  field: string;
  equals?: unknown;
  in?: readonly unknown[];
}

/** 结账页渲染的一个配置项。 */
export interface CheckoutConfigOption {
  /** 稳定 id。对上游是 configoption 的配置项 id。 */
  id: string;
  label: string;
  type: 'select' | 'quantity';
  /** 维度分组（如「规格」「网络」「镜像」），前端按分组渲染卡片。 */
  group?: string;
  /** 字段下方的说明文案（可选）。 */
  help?: string;
  /** 数量类型时的单位（核/GB/Mbps…）。 */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  /** 默认选中项（select 时为 choiceId）。缺省取第一个可用档位。 */
  defaultChoice?: string;
  /** 整体条件显隐：仅当条件满足时才展示本配置项。 */
  visibleWhen?: CheckoutVisibility;
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
  /** 附加价（minor）：select=选中增量；quantity=每单位价格。缺省 0。 */
  price?: number;
  /**
   * 按周期覆盖的增量价（cycleId → minor units）。缺省回退 {@link price}；
   * 用于表达「同一档位在不同周期价格不同」的配置矩阵。
   */
  prices?: Record<string, number>;
  /**
   * 层级联动：该档位仅在父配置项选中指定项时可用。
   * 形如 `{ data_center: ['hk','sg'] }`；数组表示任一命中，字符串表示精确匹配。
   */
  requires?: Record<string, string | string[]>;
  /**
   * 是否在续费时重复计费（缺省 true）。镜像等一次性配置可置 false，
   * 使其只计入首期、不计入续费价。
   */
  recurring?: boolean;
  qtyMin?: number;
  qtyMax?: number;
}

/** 顾客在结账时提交的选择：cycle=周期 id；selections=配置项 id → 选项 id（select）或数量（quantity）。 */
export interface CheckoutSelection {
  /** Optional customer-facing instance name, not a DNS hostname or login credential. */
  instanceName?: string;
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
 * 条件是否命中当前选择值。选择值来自 {@link CheckoutSelection.selections}（select 为
 * choiceId，quantity 为数量）或 `cycle`。比较时统一转字符串，容忍数字/字符串混用。
 */
function matchesCondition(
  value: string | number | undefined,
  condition: { equals?: unknown; in?: readonly unknown[] },
): boolean {
  if (condition.equals === undefined && condition.in === undefined) {
    return value !== undefined && value !== null && value !== '';
  }
  if (value === undefined || value === null) return false;
  if (condition.equals !== undefined && String(value) === String(condition.equals)) return true;
  if (condition.in && condition.in.some((candidate) => String(candidate) === String(value))) {
    return true;
  }
  return false;
}

/** 当前选择下可见的配置项（按 `visibleWhen` 过滤）。 */
export function visibleOptions(
  schema: CheckoutConfigSchema,
  config: CheckoutSelection,
): CheckoutConfigOption[] {
  const selections = config.selections ?? {};
  return schema.options.filter((option) => {
    if (!option.visibleWhen) return true;
    const { field } = option.visibleWhen;
    const value = field === 'cycle' ? config.cycle : selections[field];
    return matchesCondition(value, option.visibleWhen);
  });
}

/** 当前选择下某配置项可用的档位（按档位 `requires` 层级联动过滤）。 */
export function allowedChoices(
  schema: CheckoutConfigSchema,
  optionId: string,
  config: CheckoutSelection,
): CheckoutOptionChoice[] {
  const option = schema.options.find((candidate) => candidate.id === optionId);
  if (!option?.choices) return [];
  const selections = config.selections ?? {};
  return option.choices.filter((choice) => {
    if (!choice.requires) return true;
    return Object.entries(choice.requires).every(([field, expected]) => {
      const value = field === 'cycle' ? config.cycle : selections[field];
      const allowed = Array.isArray(expected) ? expected : [expected];
      return (
        value !== undefined && allowed.some((candidate) => String(candidate) === String(value))
      );
    });
  });
}

/**
 * 校验结账选择是否合法，返回违规原因列表（空数组表示合法）。
 * 检查：未知配置项、必填项缺失、档位不可用（含联动）、数量超范围。
 */
export function validateCheckoutSelection(
  schema: CheckoutConfigSchema,
  config: CheckoutSelection,
): string[] {
  const errors: string[] = [];
  const selections = config.selections ?? {};
  if (config.cycle && !schema.cycles.some((cycle) => cycle.id === config.cycle)) {
    errors.push(`未知计费周期：${config.cycle}`);
  }
  const visible = new Set(visibleOptions(schema, config).map((option) => option.id));
  for (const optionId of Object.keys(selections)) {
    if (!schema.options.some((option) => option.id === optionId)) {
      errors.push(`未知配置项：${optionId}`);
    }
  }
  for (const option of schema.options) {
    if (!visible.has(option.id)) continue;
    const raw = selections[option.id];
    if (raw === undefined || raw === null || raw === '') {
      if (option.required) errors.push(`缺少必填配置：${option.label}`);
      continue;
    }
    const choices = allowedChoices(schema, option.id, config);
    if (option.type === 'quantity') {
      const qty = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(qty)) {
        errors.push(`配置项数量无效：${option.label}`);
        continue;
      }
      const min = option.min ?? 0;
      const max = option.max ?? Number.POSITIVE_INFINITY;
      if (qty < min || qty > max) {
        errors.push(`配置项数量超范围：${option.label}`);
      }
      continue;
    }
    if (!choices.some((choice) => choice.id === raw)) {
      errors.push(`配置项档位不可用：${option.label}`);
    }
  }
  return errors;
}

/**
 * 本地计价：从 schema + 选择计算单价（minor units）。不依赖上游。
 * - select：`prices[cycleId] ?? price` 为该选项的附加价增量。
 * - quantity：`prices[cycleId] ?? price` 为单位价，按选择数量累加。
 * - 仅计可见项（`visibleWhen`）与合法档位（`requires`）。
 * - `renewPrice` 只累计 `recurring !== false` 的档位。
 * 若提供方实现了 `calculateCheckoutPrice`，应由其返回权威价；本函数是回退/本地类型用。
 */
export function computeCheckoutPrice(
  schema: CheckoutConfigSchema,
  config: CheckoutSelection,
): CheckoutPriceResult {
  const cycleId = config.cycle ?? schema.cycles[0]?.id ?? '';
  const cycle = schema.cycles.find((candidate) => candidate.id === cycleId) ?? schema.cycles[0];
  const resolvedCycleId = cycle?.id ?? cycleId;
  let price = cycle?.price ?? 0;
  let renewPrice = cycle?.renewPrice ?? cycle?.price ?? 0;
  const breakdown: CheckoutPriceResult['breakdown'] = [];
  if (cycle) breakdown.push({ label: cycle.label, value: cycle.label, price: cycle.price });
  const selections = config.selections ?? {};
  const cyclePrice = (choice: CheckoutOptionChoice): number =>
    choice.prices?.[resolvedCycleId] ?? choice.price ?? 0;
  for (const option of visibleOptions(schema, config)) {
    const raw = selections[option.id];
    if (raw === undefined || raw === null || raw === '') continue;
    const choices = allowedChoices(schema, option.id, config);
    if (option.type === 'quantity') {
      const qty = typeof raw === 'number' ? raw : Number(raw);
      const choice = choices[0];
      const unit = choice ? cyclePrice(choice) : 0;
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const line = Math.round(unit * qty);
      price += line;
      if (choice?.recurring !== false) renewPrice += line;
      breakdown.push({
        label: option.label,
        value: `${qty}${option.unit ? ` ${option.unit}` : ''}`,
        price: line,
      });
      continue;
    }
    const choice = choices.find((candidate) => candidate.id === raw);
    if (!choice) continue;
    const line = cyclePrice(choice);
    price += line;
    if (choice.recurring !== false) renewPrice += line;
    breakdown.push({ label: option.label, value: choice.label, price: line });
  }
  return {
    price,
    renewPrice,
    breakdown,
    summary: breakdown.map((item) => `${item.label}:${item.value}`).join(' · '),
  };
}
