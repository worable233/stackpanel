import { EXTENSION_POINTS } from '@stackpanel/sdk';
import type {
  HttpRequest,
  ProductTypeProvider,
  UpstreamProductSource,
} from '@stackpanel/sdk';
import { context } from './context';
import { StoreError } from './errors';

/**
 * 商品类型与上游关联（store 通用能力）。
 *
 * 商品类型由独立插件注册（EXTENSION_POINTS.productType）；store 聚合后暴露给
 * 商品表单（类型下拉 + 类型配置字段声明）。上游商品关联由上游插件注册
 * （EXTENSION_POINTS.upstreamProductSource）；store 代理搜索/取单个，不感知具体上游。
 */

/** GET /store/product-types：活跃商品类型聚合（含类型配置字段声明）。 */
export async function listProductTypes(): Promise<unknown> {
  const entries =
    context().getExtensionsWithOwner<ProductTypeProvider>(EXTENSION_POINTS.productType);
  const types = entries.flatMap(({ pluginId, implementation }) =>
    implementation.fulfillmentTypes.map((typeId) => ({
      id: typeId,
      label: implementation.label,
      pluginId,
      configFields: implementation.configFields ?? [],
    })),
  );
  return { types };
}

/** 按类型 key 找到已注册的商品类型提供方（用于创建商品时校验类型配置）。 */
export function productTypeById(typeId: string): ProductTypeProvider | undefined {
  return context()
    .getExtensions<ProductTypeProvider>(EXTENSION_POINTS.productType)
    .find((provider) => provider.fulfillmentTypes.includes(typeId));
}

/** GET /store/upstream-sources：活跃上游插件聚合。 */
export async function listUpstreamSources(): Promise<unknown> {
  const sources = context().getExtensions<UpstreamProductSource>(
    EXTENSION_POINTS.upstreamProductSource,
  );
  return { sources: sources.map((source) => ({ id: source.id, name: source.name })) };
}

function upstreamSourceById(providerId: string): UpstreamProductSource | undefined {
  return context()
    .getExtensions<UpstreamProductSource>(EXTENSION_POINTS.upstreamProductSource)
    .find((source) => source.id === providerId);
}

/** GET /store/upstream-products/:provider?q= —— 搜索上游商品（商品表单关联选择器）。 */
export async function searchUpstreamProducts(req: HttpRequest): Promise<unknown> {
  const provider = req.params['provider'];
  if (!provider) throw new StoreError(400, '缺少上游标识');
  const source = upstreamSourceById(provider);
  if (!source) throw new StoreError(404, '上游不存在或未启用');
  const q = typeof req.query['q'] === 'string' ? req.query['q'].slice(0, 100) : '';
  const items = await source.search(q, { limit: 50 });
  return { items };
}

/** GET /store/upstream-products/:provider/:productId —— 取单个（编辑时回显关联）。 */
export async function getUpstreamProduct(req: HttpRequest): Promise<unknown> {
  const provider = req.params['provider'];
  const productId = req.params['productId'];
  if (!provider || !productId) throw new StoreError(400, '缺少参数');
  const source = upstreamSourceById(provider);
  if (!source) throw new StoreError(404, '上游不存在或未启用');
  const item = await source.get(productId);
  return { item };
}
