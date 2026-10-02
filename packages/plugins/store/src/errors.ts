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
  '购物车项不存在': 'store.cart.item_not_found',
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
  '商店插件未就绪': 'store.not_ready',
};

/** Messages that carry a variable suffix; matched on the part before `：`. */
const STORE_ERROR_PREFIX_CODES: Record<string, string> = {
  商品配置无效: 'store.checkout.config_invalid',
};

export class StoreError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
    this.code =
      STORE_ERROR_CODES[message] ??
      STORE_ERROR_PREFIX_CODES[message.split(/[:：]/)[0] ?? ''] ??
      'store.error';
  }
}

/** Extract the product lines from an order's JSON payload. */
export function stockItems(order: {
  items: unknown;
}): Array<{ productId: string; quantity: number; config?: unknown }> {
  const value = order.items as {
    items?: Array<{
      productId?: unknown;
      quantity?: unknown;
      config?: unknown;
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
            ...(item.config !== undefined && item.config !== null
              ? { config: item.config }
              : {}),
          },
        ]
      : [],
  );
}