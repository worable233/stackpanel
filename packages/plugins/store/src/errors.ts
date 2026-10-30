/** Errors and guards shared across the store plugin modules. */

/**
 * Stable, machine-readable codes for store errors (ADR-0012 §2).
 *
 * The plugin throws `StoreError(status, message)` in ~80 places; rather than
 * tag each site, the message (a stable, curated string) maps to a code **here**,
 * in one place. The route wrapper promotes the error to a `PluginError` so the
 * kernel boundary renders the code. All messages are static except a small set
 * matched by their stable prefix (before `：`).
 */
const STORE_ERROR_CODES: Record<string, string> = {
  '订单 ID 无效': 'store.order.id_invalid',
  '缺少 ID': 'store.request.id_required',
  '缺少动作 ID': 'store.request.action_id_required',
  '缺少参数': 'store.request.params_required',
  '商品配置无效': 'store.checkout.config_invalid',
  '请选择支付方式': 'store.checkout.payment_method_required',
  '商品价格计算失败': 'store.pricing.failed',
  '该商品不支持配置选择': 'store.product.config_unsupported',
  '未登录': 'auth.unauthenticated',
  '商品不存在': 'store.product.not_found',
  '商品不可用': 'store.product.unavailable',
  '商品不可用或库存不足': 'store.product.unavailable',
  '商品不可购买': 'store.product.not_purchasable',
  '购物车项不存在': 'store.cart.item_not_found',
  '分类不存在': 'store.category.not_found',
  '上游不存在或未启用': 'store.upstream.not_enabled',
  '销售渠道不存在或未启用': 'store.channel.not_enabled',
  '库存不足': 'store.stock.insufficient',
  '购物车为空': 'store.cart.empty',
  '订单无法取消': 'store.order.not_cancellable',
  '订单状态已变更': 'store.order.state_changed',
  '任务不存在或不可重试': 'store.task.not_retryable',
  '支付仍在处理中，无法取消': 'store.order.payment_processing',
  '订单商品币种不一致，请分开下单': 'store.order.currency_mismatch',
  '该服务不支持此操作': 'store.service.unsupported',
  '该服务暂不支持此操作': 'store.service.unsupported',
  '商店插件未就绪': 'store.not_ready',
  // 续费 / 退款 / 运维动作（本次新增）
  '请求参数无效': 'store.request.invalid',
  '缺少服务 ID': 'store.request.service_id_required',
  '服务不存在': 'store.service.not_found',
  '该服务当前状态不可续费': 'store.service.not_renewable',
  '订单金额无效': 'store.order.amount_invalid',
  '订单金额过大': 'store.order.amount_too_large',
  '订单不可支付': 'store.order.not_payable',
  '幂等键已用于不同的请求，请重新提交': 'store.request.idempotency_conflict',
  '相同请求正在处理中，请稍候': 'store.request.concurrent_request',
  '商品结账配置无效': 'store.checkout.config_invalid',
  '商品已产生交易，不能修改币种': 'currency.product_immutable',
  '商品已停售，无法赠送': 'store.product.unavailable',
  '服务已属于该用户': 'store.service.already_owned',
  '该服务当前状态不可变更': 'store.service.not_changeable',
  '该订单为合作方预付，不支持钱包退款': 'store.order.partner_prepaid_no_refund',
  '订单不可退款': 'store.order.not_refundable',
  '退款金额无效': 'store.refund.amount_invalid',
  '退款金额超过订单金额': 'store.refund.amount_exceeds',
  '动作参数无效': 'store.service.action_param_invalid',
};

/** Messages that carry a variable suffix; matched on the part before `：`. */
const STORE_ERROR_PREFIX_CODES: Record<string, string> = {
  商品配置无效: 'store.checkout.config_invalid',
  // 动态列出被拒项与可用项，故只按稳定前缀映射。
  该服务不支持变更这些配置项: 'store.change.option_unsupported',
};

export class StoreError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
    /** Explicit stable code (e.g. kernel `currency.*` errors passed through). */
    code?: string,
  ) {
    super(message);
    this.name = 'StoreError';
    this.code =
      code ??
      STORE_ERROR_CODES[message] ??
      STORE_ERROR_PREFIX_CODES[message.split(/[:：]/)[0] ?? ''] ??
      'store.error';
  }
}

/** Extract the product lines from an order's JSON payload. */
export function stockItems(order: {
  items: unknown;
}): Array<{
  productId: string;
  quantity: number;
  price?: number;
  config?: unknown;
  /** 续费订单行：指向被续费的服务实例 id（非空则本行不产生交付任务）。 */
  renewalServiceId?: string;
  /** 续费时长（月）。 */
  renewMonths?: number;
  /** 续费前服务到期时间（ISO），供全额退款精确回滚；`null` = 续费前无到期。 */
  previousExpiresAt?: string | null;
  /** 续费前服务状态，供全额退款回滚。 */
  previousState?: string;
  /** 变更订单行（升配/降配/换商品）：指向被变更的服务实例 id。 */
  changeServiceId?: string;
  /** 变更类型：`package`（升配降配）| `product`（换商品）。 */
  changeType?: string;
  /** 变更后的目标商品 id（换商品用；升配降配时可空）。 */
  changeTargetProductId?: string;
  /** 变更后的目标配置选择（JSON 对象）。 */
  changeSelection?: unknown;
  /** 变更是否已应用（幂等标记）。 */
  changeApplied?: boolean;
  /** 变更前的商品 id，供全额退款回滚。 */
  previousProductId?: string;
  /** 变更前的配置选择，供全额退款回滚。 */
  previousSelection?: unknown;
  /** 上一次应用失败的原因（非空表示变更尚未落地，而用户已付款）。 */
  changeError?: string;
  /** 已尝试应用次数（用于退避与人工判断）。 */
  changeAttempts?: number;
  /** 下一次允许自动重试的时间戳（毫秒）。 */
  changeNextAttemptAtMs?: number;
}> {
  const value = order.items as {
    items?: Array<{
      productId?: unknown;
      quantity?: unknown;
      price?: unknown;
      config?: unknown;
      renewalServiceId?: unknown;
      renewMonths?: unknown;
      previousExpiresAt?: unknown;
      previousState?: unknown;
      changeServiceId?: unknown;
      changeType?: unknown;
      changeTargetProductId?: unknown;
      changeSelection?: unknown;
      changeApplied?: unknown;
      previousProductId?: unknown;
      previousSelection?: unknown;
      changeError?: unknown;
      changeAttempts?: unknown;
      changeNextAttemptAtMs?: unknown;
    }>;
  };
  return (value.items ?? []).flatMap((item) =>
    typeof item.productId === 'string' &&
    typeof item.quantity === 'number' &&
    Number.isInteger(item.quantity) &&
    item.quantity > 0
      ? [
          {
            productId: item.productId,
            quantity: item.quantity,
            ...(typeof item.price === 'number' && Number.isSafeInteger(item.price) && item.price >= 0 ? { price: item.price } : {}),
            ...(item.config !== undefined && item.config !== null
              ? { config: item.config }
              : {}),
            ...(typeof item.renewalServiceId === 'string'
              ? { renewalServiceId: item.renewalServiceId }
              : {}),
            ...(typeof item.renewMonths === 'number' && Number.isInteger(item.renewMonths)
              ? { renewMonths: item.renewMonths }
              : {}),
            ...('previousExpiresAt' in item
              ? { previousExpiresAt: item.previousExpiresAt as string | null }
              : {}),
            ...(typeof item.previousState === 'string'
              ? { previousState: item.previousState }
              : {}),
            ...(typeof item.changeServiceId === 'string'
              ? { changeServiceId: item.changeServiceId }
              : {}),
            ...(typeof item.changeType === 'string' ? { changeType: item.changeType } : {}),
            ...(typeof item.changeTargetProductId === 'string'
              ? { changeTargetProductId: item.changeTargetProductId }
              : {}),
            ...(item.changeSelection !== undefined && item.changeSelection !== null
              ? { changeSelection: item.changeSelection }
              : {}),
            ...(item.changeApplied === true ? { changeApplied: true } : {}),
            ...(typeof item.previousProductId === 'string'
              ? { previousProductId: item.previousProductId }
              : {}),
            ...(typeof item.changeError === 'string' ? { changeError: item.changeError } : {}),
            ...(typeof item.changeAttempts === 'number' && Number.isInteger(item.changeAttempts)
              ? { changeAttempts: item.changeAttempts }
              : {}),
            ...(typeof item.changeNextAttemptAtMs === 'number' &&
            Number.isFinite(item.changeNextAttemptAtMs)
              ? { changeNextAttemptAtMs: item.changeNextAttemptAtMs }
              : {}),
            ...('previousSelection' in item
              ? { previousSelection: item.previousSelection }
              : {}),
          },
        ]
      : [],
  );
}
