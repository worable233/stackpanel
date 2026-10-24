import {
  computeCheckoutPrice,
  readCheckoutConfig,
  validateCheckoutSelection,
} from '@stackpanel/sdk';
import type {
  CheckoutPriceContext,
  CheckoutPriceResult,
  CheckoutSelection,
  FxQuote,
  HttpRequest,
} from '@stackpanel/sdk';
import { StoreError } from './errors';
import { context } from './context';
import {
  anonymousGroupDiscount,
  applyDiscount,
  betterDiscount,
  effectiveGroupDiscount,
} from './discount';
import { getProduct } from './repository';
import { providerForProduct } from './fulfillment';
import { parseCheckoutSelection } from './utils';

/**
 * 折扣口径的**唯一真值**在 `discount.ts`；这里只是历史命名下的转发。
 *
 * 保留这两个名字是因为调用点很多（cart/orders/pricing 自己的试算），改名字只会
 * 制造无意义的 diff。但实现必须只有一份：两个文件各算一遍折扣，早晚会分叉成
 * 「商品页一个价、下单另一个价」。
 */
export async function effectiveDiscount(userId: string): Promise<number> {
  return effectiveGroupDiscount(userId);
}

/** @see betterDiscount / applyDiscount —— 取更优者（不叠加），并封顶 99%。 */
export function discountedPrice(
  unit: number,
  productDiscount: number | null | undefined,
  groupDiscount: number,
): number {
  return applyDiscount(unit, betterDiscount(productDiscount, groupDiscount));
}

/** 商品的结账计价上下文（product 快照）。 */
export interface PricedLine {
  unit: number;
  renewPrice?: number;
  summary?: string;
  breakdown?: CheckoutPriceResult['breakdown'];
}

/**
 * 解析「商品 + 结账配置」的权威单价（minor units）。
 * 1. 若商品有履约提供方且实现了 `calculateCheckoutPrice` → 以其为准（上游 get_total / 本地类型插件）。
 * 2. 否则回退：用商品 metadata 的 checkoutConfig 做本地静态计价。
 * 3. 无配置 → 返回商品静态价格（沿用商品自身/权限组折扣在 orders.ts 中应用）。
 */
export async function resolveCheckoutPrice(
  product: {
    id: string;
    price: number;
    currency: string;
    metadata: unknown;
    providerId: string | null;
    providerProductId: string | null;
    fulfillmentType: string;
  },
  quantity: number,
  config: CheckoutSelection | undefined,
): Promise<{ unit: number; result: CheckoutPriceResult | null }> {
  const schema = readCheckoutConfig(product.metadata);
  if (!config || (!config.cycle && !config.selections)) {
    if (schema) throw new StoreError(400, '商品配置无效：请选择商品配置');
    return { unit: product.price, result: null };
  }
  if (schema) {
    const errors = validateCheckoutSelection(schema, config);
    if (errors.length > 0) throw new StoreError(400, `商品配置无效：${errors[0]}`);
  }
  const provider = providerForProduct({
    providerId: product.providerId,
    fulfillmentType: product.fulfillmentType,
  });
  const priceCtx: CheckoutPriceContext = {
    product: {
      id: product.id,
      price: product.price,
      currency: product.currency,
      metadata: product.metadata,
      providerProductId: product.providerProductId,
    },
    quantity,
    config,
  };
  if (provider?.calculateCheckoutPrice) {
    const result = await provider.calculateCheckoutPrice(priceCtx);
    if (result && Number.isSafeInteger(result.price) && result.price >= 0) {
      return { unit: result.price, result };
    }
    throw new StoreError(400, '商品价格计算失败');
  }
  if (!schema) throw new StoreError(400, '该商品不支持配置选择');
  const result = computeCheckoutPrice(schema, config);
  return { unit: result.price, result };
}

/** GET/POST /store/products/:id/price —— 按配置试算价格（商品页「计算价格」）。 */
export async function calculateProductPrice(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const product = await getProduct(id);
  if (!product || product.status !== 'ACTIVE') throw new StoreError(404, '商品不存在');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const config = parseCheckoutSelection(body['config']);
  const quantity = Number(body['quantity'] ?? 1);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new StoreError(400, '请求参数无效');
  }
  const priced = await resolveCheckoutPrice(product, quantity, config);
  // 同一份折扣算一次，供单价与续费价共用：连算两次等于给「两条路径算出两个价」
  // 留了入口（例如有人在中间改了 `effectiveDiscount` 的实现）。
  const userId = req.user?.id;
  const groupDiscount = userId ? await effectiveGroupDiscount(userId) : anonymousGroupDiscount();
  const discount = betterDiscount(product.discount, groupDiscount);
  const unit = applyDiscount(priced.unit, discount);
  const result = priced.result;
  const total = unit * quantity;
  // Settlement preview (plan §5): show the original amount *and* what the buyer
  // will actually be charged. A missing rate must not break the preview — the
  // authoritative gate is order creation, which fails closed.
  const settlement = await previewSettlement(product.currency, total);
  return {
    productId: id,
    price: unit,
    // 未打折单价：前端用来展示划线原价与折扣标签（`price` 已是实付单价）。
    basePrice: priced.unit,
    discount: discount > 0 ? discount : null,
    currency: product.currency,
    quantity,
    total,
    originalTotal: priced.unit * quantity,
    ...(settlement
      ? {
          settlementCurrency: settlement.toCurrency,
          settlementTotal: settlement.settlementAmount,
          fxRate: settlement.rate,
        }
      : {}),
    ...(result
      ? {
          // 续费价同样要打折：否则「首期便宜、续费恢复原价」会静默发生。
          renewPrice: applyDiscount(result.renewPrice ?? priced.unit, discount),
          breakdown: result.breakdown ?? [],
          summary: result.summary,
        }
      : {}),
  };
}

/** Best-effort settlement quote for the public price preview. */
async function previewSettlement(currency: string, totalMinor: number): Promise<FxQuote | null> {
  try {
    return await context().fx.quoteToSettlement(currency, totalMinor);
  } catch {
    return null;
  }
}
