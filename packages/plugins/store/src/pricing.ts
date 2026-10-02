import { computeCheckoutPrice, readCheckoutConfig } from '@stackpanel/sdk';
import type {
  CheckoutPriceContext,
  CheckoutPriceResult,
  CheckoutSelection,
  HttpRequest,
} from '@stackpanel/sdk';
import { StoreError } from './errors';
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
  if (!config || (!config.cycle && !config.selections)) {
    return { unit: product.price, result: null };
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
  const schema = readCheckoutConfig(product.metadata);
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
  const { unit, result } = await resolveCheckoutPrice(product, quantity, config);
  return {
    productId: id,
    price: unit,
    currency: product.currency,
    quantity,
    total: unit * quantity,
    ...(result
      ? {
          renewPrice: result.renewPrice ?? unit,
          breakdown: result.breakdown ?? [],
          summary: result.summary,
        }
      : {}),
  };
}
