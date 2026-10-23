import { computeCheckoutPrice, readCheckoutConfig, validateCheckoutSelection } from '@stackpanel/sdk';
import type {
  CheckoutPriceContext,
  CheckoutPriceResult,
  CheckoutSelection,
  FxQuote,
  HttpRequest,
} from '@stackpanel/sdk';
import { StoreError } from './errors';
import { context } from './context';
import { anonymousGroupDiscount, applyDiscount, betterDiscount, effectiveGroupDiscount } from './discount';
import { getProduct } from './repository';
import { providerForProduct } from './fulfillment';
import { parseCheckoutSelection } from './utils';

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
 * 3. 无配置 → 返回商品静态价格。
 *
 * **不含折扣**：本函数只解析「配置带来的单价」，折扣由调用方用 `discount.ts`
 * 统一应用（`applyDiscount` + `betterDiscount`）。展示与下单必须共用同一套规则。
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
  if (!config || (!config.cycle && !config.selections)) {
    return { unit: product.price, result: null };
  }
  const schema = readCheckoutConfig(product.metadata);
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
    if (result && Number.isFinite(result.price)) {
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
  const quantity = typeof body['quantity'] === 'number' ? body['quantity'] : 1;
  const { unit: baseUnit, result } = await resolveCheckoutPrice(product, quantity, config);
  // 折扣必须与下单同源（discount.ts）：页面试算若不打折，用户看到的价与实际
  // 扣款不一致。未登录时只有商品折扣，登录后再叠加（取更优）权限组折扣。
  const userId = req.user?.id;
  const groupDiscount = userId ? await effectiveGroupDiscount(userId) : anonymousGroupDiscount();
  const discount = betterDiscount(product.discount, groupDiscount);
  const unit = applyDiscount(baseUnit, discount);
  const total = unit * quantity;
  // Settlement preview (plan §5): show the original amount *and* what the buyer
  // will actually be charged. A missing rate must not break the preview — the
  // authoritative gate is order creation, which fails closed.
  const settlement = await previewSettlement(product.currency, total);
  return {
    productId: id,
    price: unit,
    // 未打折单价：前端用来展示划线原价与折扣标签（`price` 已是实付单价）。
    basePrice: baseUnit,
    discount: discount > 0 ? discount : null,
    currency: product.currency,
    quantity,
    total,
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
          renewPrice: applyDiscount(result.renewPrice ?? baseUnit, discount),
          breakdown: result.breakdown ?? [],
          summary: result.summary,
        }
      : {}),
  };
}

/** Best-effort settlement quote for the public price preview. */
async function previewSettlement(
  currency: string,
  totalMinor: number,
): Promise<FxQuote | null> {
  try {
    return await context().fx.quoteToSettlement(currency, totalMinor);
  } catch {
    return null;
  }
}
