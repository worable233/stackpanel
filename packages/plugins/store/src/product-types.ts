import { EXTENSION_POINTS } from '@stackpanel/sdk';
import type {
  HttpRequest,
  ProductConfigField,
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
  const entries = context().getExtensionsWithOwner<ProductTypeProvider>(
    EXTENSION_POINTS.productType,
  );
  const types = entries.flatMap(({ pluginId, implementation }) =>
    implementation.fulfillmentTypes.map((typeId) => ({
      id: typeId,
      label: implementation.label,
      pluginId,
      configFields: implementation.configFields ?? [],
    })),
  );
  // 动态候选项（如「授予哪个权限组」）由 store 在聚合时填充：类型插件只能声明
  // 静态 options，而权限组是运行期数据。填充失败时保留空 options，商品表单仍
  // 可渲染，只是下拉为空——不能让一个选项源故障拖垮整个类型列表。
  const permissionGroups = await loadPermissionGroups();
  return { types: types.map((type) => ({ ...type, configFields: fillOptions(type.configFields, permissionGroups) })) };
}

/** 当前平台权限组（供 `optionsSource: 'permissionGroups'` 填充）。 */
async function loadPermissionGroups(): Promise<Array<{ label: string; value: string }>> {
  try {
    const groups = await context().auth.listPermissionGroups();
    return groups.map((group) => ({
      label: group.discount != null && group.discount > 0 ? `${group.name}（${group.discount}% 折扣）` : group.name,
      value: group.id,
    }));
  } catch {
    return [];
  }
}

/**
 * 按字段声明填充动态候选项。
 *
 * `optionsSource` 是类型插件与 store 之间的约定：插件声明「我要哪一类运行期
 * 选项」，store 负责解析成 `options`，避免插件自己去查内核数据（插件拿不到
 * 权限组列表以外的上下文，也不该为渲染表单而调管理端接口）。
 */
function fillOptions(
  fields: readonly ProductConfigField[],
  permissionGroups: Array<{ label: string; value: string }>,
): ProductConfigField[] {
  return fields.map((field) => {
    const withChildren =
      field.fields && field.fields.length > 0
        ? { ...field, fields: fillOptions(field.fields, permissionGroups) }
        : field;
    if (withChildren.optionsSource !== 'permissionGroups') return withChildren;
    return { ...withChildren, options: permissionGroups };
  });
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

/**
 * GET /store/upstream-products/:provider/:productId/config —— 取上游商品的结账配置
 * （周期 + 配置项），供商品表单「一键填充」。上游未实现或商品不可配置时返回 null。
 */
export async function getUpstreamProductConfig(req: HttpRequest): Promise<unknown> {
  const provider = req.params['provider'];
  const productId = req.params['productId'];
  if (!provider || !productId) throw new StoreError(400, '缺少参数');
  const source = upstreamSourceById(provider);
  if (!source) throw new StoreError(404, '上游不存在或未启用');
  if (!source.getConfig) return { checkoutConfig: null };
  const checkoutConfig = await source.getConfig(productId);
  return { checkoutConfig };
}
