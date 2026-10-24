import type { HttpReply, HttpRequest } from '@stackpanel/sdk';
import { EXTENSION_POINTS, isExtensionNotFound } from '@stackpanel/sdk';
import type { FulfillmentProvider, UpstreamProductSource } from '@stackpanel/sdk';
import { context } from './context';
import { StoreError } from './errors';
import { productTypeById } from './product-types';
import {
  createProductInstance,
  deleteProductInstance,
  getProduct as getProductRecord,
  listActiveProductsPage,
  listAllProductsPage,
  listAllProducts as listAllProductRecords,
  listProductsByIds as listProductRecordsByIds,
  releaseProductStock,
  replaceProduct,
  setProductStock,
  type ProductRecord,
} from './repository';
import {
  parsePagination,
  productSchema,
  productUpdateSchema,
  validateCheckoutConfig,
} from './utils';
import { toPublicProduct, toPurchasableProduct } from './contracts';
import { assertCurrencyMutable, resolveProductCurrency } from './currency';

/** Read-only product summary exposed to other plugins. */
export interface StoreProductRead {
  listAll(): Promise<StoreProductSummary[]>;
  listByIds(ids: string[]): Promise<StoreProductSummary[]>;
  getById(id: string): Promise<StoreProductSummary | null>;
}

/** Minimal stock mutation exposed to other plugins. */
export interface StoreProductUpdate {
  updateStock(productId: string, stock: number): Promise<boolean>;
  /** Create a product on behalf of an upstream sync. */
  create(input: StoreProductMutation): Promise<StoreProductSummary>;
  /** Patch an existing product; returns null when missing. */
  update(productId: string, patch: StoreProductPatch): Promise<StoreProductSummary | null>;
  /** Remove a product; returns whether a row was removed. */
  remove(productId: string): Promise<boolean>;
}

/** Fields an upstream sync may set when creating a product. */
export interface StoreProductMutation {
  name: string;
  price: number;
  currency: string;
  stock: number;
  cost?: number | null;
  status?: string;
  description?: string | null;
  metadata?: unknown;
  fulfillmentType?: string;
  providerId?: string | null;
  providerProductId?: string | null;
}

/** Fields an upstream sync may patch on an existing product. */
export type StoreProductPatch = Partial<StoreProductMutation>;

export interface StoreProductSummary {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  status: string;
  categoryId: string | null;
  fulfillmentType: string;
  providerId: string | null;
  providerProductId: string | null;
  createdAt: Date;
  metadata: unknown;
}

const toSummary = (record: ProductRecord): StoreProductSummary => ({ ...record });

/**
 * 公开目录：只返回公开展厅 DTO，绝不外泄成本价、上游 provider 标识与内部
 * metadata（PLAN §4.3）。管理端字段白名单在 `listAdminProducts` 另行处理。
 */
export async function listProducts(req: HttpRequest): Promise<unknown> {
  const { page, pageSize } = parsePagination(req.query);
  const categoryId =
    typeof req.query['categoryId'] === 'string' ? req.query['categoryId'] : undefined;
  const { items, total } = await listActiveProductsPage(page, pageSize, categoryId);
  return { products: items.map(toPublicProduct), total, page, pageSize };
}

/**
 * 账户商城目录：登录用户可购买列表。返回 `PurchasableProduct`，服务端结合
 * 商品状态、库存与调用者 `store.buy` 资格判定 `purchasable`。
 */
export async function listPurchasableProducts(req: HttpRequest): Promise<unknown> {
  const { page, pageSize } = parsePagination(req.query);
  const categoryId =
    typeof req.query['categoryId'] === 'string' ? req.query['categoryId'] : undefined;
  const query =
    typeof req.query['q'] === 'string' ? req.query['q'].trim().slice(0, 120) : undefined;
  const { items, total } = await listActiveProductsPage(
    page,
    pageSize,
    categoryId,
    query || undefined,
  );
  const canBuy = await canBuyProducts(req);
  return {
    products: items.map((item) => toPurchasableProduct(item, canBuy)),
    total,
    page,
    pageSize,
  };
}

/** 账户商城商品详情：单件可购买视图。 */
export async function getPurchasableProduct(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  let product = await getProductRecord(id);
  if (!product || product.status !== 'ACTIVE') throw new StoreError(404, '商品不存在');
  // The catalog scheduler may run hours apart. Recheck a bound product when
  // opening checkout, rather than treating an old zero snapshot as sold out.
  if (product.providerId && product.providerProductId) {
    const source = context()
      .getExtensions<UpstreamProductSource>(EXTENSION_POINTS.upstreamProductSource)
      .find((candidate) => candidate.id === product!.providerId);
    const metadata = product.metadata as Record<string, unknown> | null;
    const binding = metadata?.upstream as { sourceRef?: string } | undefined;
    if (source && binding?.sourceRef) {
      try {
        const live = await source.get(product.providerProductId, { sourceRef: binding.sourceRef });
        if (
          live?.stock !== undefined &&
          Number.isInteger(live.stock) &&
          live.stock >= 0 &&
          live.stock <= 1_000_000
        ) {
          if (live.stock !== product.stock) await setProductStock(id, live.stock);
          product = { ...product, stock: live.stock };
        }
      } catch {
        // Keep the conservative stored stock on upstream failure; never invent availability.
      }
    }
  }
  const canBuy = await canBuyProducts(req);
  return { product: toPurchasableProduct(product, canBuy) };
}

/** 调用者是否持有购买资格；未登录或无权限均视为不可购买。 */
async function canBuyProducts(req: HttpRequest): Promise<boolean> {
  const userId = req.user?.id;
  if (!userId) return false;
  return context().auth.hasPermission(userId, 'store.buy');
}

export async function getProduct(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const product = await getProductRecord(id);
  if (!product || product.status !== 'ACTIVE') throw new StoreError(404, '商品不存在');
  return { product: toPublicProduct(product) };
}

export async function listAllProducts(): Promise<StoreProductSummary[]> {
  return (await listAllProductRecords()).map(toSummary);
}

export async function listProductsByIds(ids: string[]): Promise<StoreProductSummary[]> {
  return (await listProductRecordsByIds(ids)).map(toSummary);
}

export async function getProductById(id: string): Promise<StoreProductSummary | null> {
  const record = await getProductRecord(id);
  return record ? toSummary(record) : null;
}

export async function updateProductStock(productId: string, stock: number): Promise<boolean> {
  return setProductStock(productId, stock);
}

/** Upstream sync: create a product through the store domain (no raw DB). */
export async function createProductForSync(
  input: StoreProductMutation,
): Promise<StoreProductSummary> {
  // Upstream sync must never write a currency outside the catalog: an unknown
  // code is a hard error, not a silently accepted product (plan §4.2).
  const currency = await resolveProductCurrency(input.currency);
  const fulfillmentType = input.fulfillmentType ?? 'instant';
  const providerId = input.providerId ?? null;
  assertCloudServerProvider(fulfillmentType, providerId);
  const product = await createProductInstance({
    name: input.name,
    description: input.description ?? null,
    price: input.price,
    currency,
    cost: input.cost ?? null,
    originalPrice: null,
    discount: null,
    stock: input.stock,
    status: input.status ?? 'ACTIVE',
    metadata: input.metadata ?? null,
    categoryId: null,
    fulfillmentType,
    providerId,
    providerProductId: input.providerProductId ?? null,
  });
  return toSummary(product);
}

/** Upstream sync: patch an existing product; returns null when missing. */
export async function updateProductForSync(
  productId: string,
  patch: StoreProductPatch,
): Promise<StoreProductSummary | null> {
  const existing = await getProductRecord(productId);
  if (!existing) return null;
  const nextCurrency =
    patch.currency !== undefined ? await resolveProductCurrency(patch.currency) : undefined;
  const next = {
    ...toProductData(existing),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.price !== undefined ? { price: patch.price } : {}),
    ...(patch.stock !== undefined ? { stock: patch.stock } : {}),
    ...(patch.cost !== undefined ? { cost: patch.cost ?? null } : {}),
    ...(nextCurrency ? { currency: nextCurrency } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.metadata !== undefined ? { metadata: patch.metadata ?? null } : {}),
    ...(patch.fulfillmentType !== undefined ? { fulfillmentType: patch.fulfillmentType } : {}),
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
    ...(patch.providerProductId !== undefined
      ? { providerProductId: patch.providerProductId }
      : {}),
  };
  assertCloudServerProvider(next.fulfillmentType, next.providerId);
  const updated = await replaceProduct(productId, next);
  return toSummary(updated);
}

/** Upstream sync: remove a product; returns whether a row was removed. */
export async function removeProductForSync(productId: string): Promise<boolean> {
  const existing = await getProductRecord(productId);
  if (!existing) return false;
  await deleteProductInstance(productId);
  return true;
}

export async function listAdminProducts(req: HttpRequest): Promise<unknown> {
  const { page, pageSize } = parsePagination(req.query);
  const { items, total } = await listAllProductsPage(page, pageSize);
  return { products: items.map(toSummary), total, page, pageSize };
}

export async function createProduct(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const body = coerceMetadataBody(req.body);
  const parsed = productSchema.safeParse(body);
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  // Catalog validation happens here (not just in the admin UI): free-text codes
  // and disabled currencies are rejected with a stable code (plan §4.2).
  const currency = await resolveProductCurrency(parsed.data.currency);
  validateCheckoutConfig(parsed.data.metadata ?? null);
  validateTypeConfig(parsed.data.fulfillmentType, parsed.data.metadata);
  assertCloudServerProvider(parsed.data.fulfillmentType, parsed.data.providerId ?? null);
  const product = await createProductInstance({
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    price: parsed.data.price,
    currency,
    cost: parsed.data.cost ?? null,
    originalPrice: parsed.data.originalPrice ?? null,
    discount: parsed.data.discount ?? null,
    stock: parsed.data.stock,
    status: 'ACTIVE',
    metadata: parsed.data.metadata ?? null,
    categoryId: parsed.data.categoryId ?? null,
    fulfillmentType: parsed.data.fulfillmentType,
    providerId: parsed.data.providerId ?? null,
    providerProductId: parsed.data.providerProductId ?? null,
  });
  await syncUpstreamAssociation(
    product.id,
    parsed.data.providerId,
    parsed.data.providerProductId,
    parsed.data.upstreamSourceRef,
  );
  return reply.code(201).send({ product: toSummary(product) });
}

export async function updateProduct(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const body = coerceMetadataBody(req.body);
  const parsed = productUpdateSchema.safeParse(body);
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  validateCheckoutConfig(parsed.data.metadata ?? null);
  if (parsed.data.fulfillmentType !== undefined && parsed.data.metadata !== undefined) {
    validateTypeConfig(parsed.data.fulfillmentType, parsed.data.metadata);
  }
  const existing = await getProductRecord(id);
  if (!existing) throw new StoreError(404, '商品不存在');
  const patch = parsed.data;
  // 币种治理（plan §4.2）：已产生订单/购物车/服务实例的商品禁止改币种；
  // 未售商品改币种时同样走目录校验（不接受任意三字符文本）。
  let nextCurrency: string | undefined;
  if (patch.currency !== undefined) {
    nextCurrency = await resolveProductCurrency(patch.currency);
    if (nextCurrency !== existing.currency) await assertCurrencyMutable(id);
  }
  const next = {
    ...toProductData(existing),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.price !== undefined ? { price: patch.price } : {}),
    ...(patch.stock !== undefined ? { stock: patch.stock } : {}),
    ...(nextCurrency ? { currency: nextCurrency } : {}),
    ...(patch.cost !== undefined ? { cost: patch.cost ?? null } : {}),
    ...(patch.originalPrice !== undefined ? { originalPrice: patch.originalPrice ?? null } : {}),
    ...(patch.discount !== undefined ? { discount: patch.discount ?? null } : {}),
    ...(patch.metadata !== undefined ? { metadata: patch.metadata ?? null } : {}),
    ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId ?? null } : {}),
    ...(patch.fulfillmentType !== undefined ? { fulfillmentType: patch.fulfillmentType } : {}),
    ...(patch.providerId !== undefined ? { providerId: patch.providerId ?? null } : {}),
    ...(patch.providerProductId !== undefined
      ? { providerProductId: patch.providerProductId ?? null }
      : {}),
  };
  assertCloudServerProvider(next.fulfillmentType, next.providerId);
  try {
    const product = await replaceProduct(id, next);
    await syncUpstreamAssociation(
      product.id,
      patch.providerId ?? product.providerId ?? null,
      patch.providerProductId ?? product.providerProductId ?? null,
      patch.upstreamSourceRef ?? upstreamSourceRef(product.metadata),
    );
    return { product: toSummary(product) };
  } catch (error) {
    if (isExtensionNotFound(error)) throw new StoreError(404, '商品不存在');
    throw error;
  }
}

/** Cloud servers cannot use the former local demo fulfillment fallback. */
export function assertCloudServerProvider(
  fulfillmentType: string,
  providerId: string | null,
): void {
  if (fulfillmentType !== 'cloud_server') return;
  if (!providerId) {
    throw new StoreError(400, '云服务器商品必须绑定真实履约提供方');
  }
  const provider = context()
    .getExtensions<FulfillmentProvider>(EXTENSION_POINTS.fulfillmentProvider)
    .find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new StoreError(400, '所选云服务器履约提供方未启用');
  }
  if (!provider.fulfillmentTypes.includes('cloud_server')) {
    throw new StoreError(400, '所选履约提供方不支持云服务器商品');
  }
}

/**
 * 商品与上游的关联建立/解除。
 *
 * 关联信息全部落在商品自身：`providerId` + `providerProductId` 定位「哪个上游插件的
 * 哪个商品」，实例（账号）标识与上游源价写入 `metadata.upstream`，履约层据此定位。
 * store 不持有任何上游映射表，对具体上游零感知；这里只调用上游插件的可选副作用钩子。
 */
async function syncUpstreamAssociation(
  productId: string,
  providerId: string | null | undefined,
  providerProductId: string | null | undefined,
  sourceRef?: string | null,
): Promise<void> {
  const sources = context().getExtensions<UpstreamProductSource>(
    EXTENSION_POINTS.upstreamProductSource,
  );
  const current = await getProductRecord(productId);
  if (!current) return;

  if (providerId && providerProductId) {
    const source = sources.find((candidate) => candidate.id === providerId);
    if (!source) return;
    const item = await source
      .get(providerProductId, sourceRef ? { sourceRef } : undefined)
      .catch(() => null);
    // 上游暂时取不到该商品时不改动已有绑定，避免网络抖动误清关联。
    if (!item) return;
    await mergeUpstreamBinding(current, {
      providerId: source.id,
      sourceRef: item.sourceRef ?? null,
      productId: item.id,
      sourcePrice: item.price ?? null,
      // 上游价格是货源成本的权威值，不保留会逐步过期的人工副本。
      cost: item.price ?? null,
      stock: normalizeUpstreamStock(item.stock),
    });
    await source.associate?.({ productId, item }).catch(() => undefined);
    return;
  }

  // 解除关联：清掉商品上的上游标记，并通知所有上游（它们自行判断是否处理过该商品）。
  await mergeUpstreamBinding(current, null);
  for (const source of sources) {
    await source.dissociate?.(productId).catch(() => undefined);
  }
}

/** Read the already verified upstream instance id when editing an existing binding. */
function upstreamSourceRef(metadata: unknown): string | undefined {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
    return undefined;
  const upstream = (metadata as Record<string, unknown>).upstream;
  if (upstream === null || typeof upstream !== 'object' || Array.isArray(upstream))
    return undefined;
  const sourceRef = (upstream as Record<string, unknown>).sourceRef;
  return typeof sourceRef === 'string' && sourceRef ? sourceRef : undefined;
}

/** Ignore malformed optional stock from a third-party upstream source. */
function normalizeUpstreamStock(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;
}

/** 合并/移除商品 metadata 中的 `upstream` 标记（保留其余 metadata 键）。 */
async function mergeUpstreamBinding(
  record: ProductRecord,
  binding: (Record<string, unknown> & { cost: number | null; stock: number | null }) | null,
): Promise<void> {
  const base =
    record.metadata !== null &&
    typeof record.metadata === 'object' &&
    !Array.isArray(record.metadata)
      ? { ...(record.metadata as Record<string, unknown>) }
      : {};
  if (binding) {
    const { cost, stock, ...upstream } = binding;
    base.upstream = upstream;
    await replaceProduct(record.id, {
      ...toProductData(record),
      metadata: base,
      ...(cost !== null ? { cost } : {}),
      ...(stock !== null ? { stock } : {}),
    });
    return;
  }
  delete base.upstream;
  await replaceProduct(record.id, { ...toProductData(record), metadata: base });
}

/**
 * 商品表单可能把 metadata 以 JSON 字符串提交（类型配置动态字段）。
 * 这里把字符串解析回对象后再走 schema 校验。
 */
function coerceMetadataBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return body as Record<string, unknown>;
  const record = body as Record<string, unknown>;
  if (typeof record.metadata === 'string') {
    try {
      record.metadata = JSON.parse(record.metadata) as unknown;
    } catch {
      throw new StoreError(400, '商品配置格式无效');
    }
  }
  return record;
}

/** 创建/编辑商品时，用类型插件的 configSchema 校验类型配置（metadata）。 */
function validateTypeConfig(
  fulfillmentType: string,
  metadata: Record<string, unknown> | null | undefined,
): void {
  const typeProvider = productTypeById(fulfillmentType);
  if (!typeProvider?.configSchema) return;
  const result = typeProvider.configSchema.safeParse(metadata ?? {});
  if (!result.success)
    throw new StoreError(
      400,
      `商品配置无效：${result.error.issues[0]?.message ?? '配置不符合类型要求'}`,
    );
}

export async function deleteProduct(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  try {
    await deleteProductInstance(id);
    return reply.code(204).send();
  } catch (error) {
    if (isExtensionNotFound(error)) throw new StoreError(404, '商品不存在');
    throw error;
  }
}

/** 领域记录 → 载荷（补齐 data.ts 声明的可空默认值）。 */
export function toProductData(record: ProductRecord): import('./data.js').StoreProductData {
  return {
    name: record.name,
    description: record.description,
    price: record.price,
    currency: record.currency,
    cost: record.cost,
    originalPrice: record.originalPrice,
    discount: record.discount,
    stock: record.stock,
    status: record.status,
    metadata: record.metadata,
    categoryId: record.categoryId,
    fulfillmentType: record.fulfillmentType,
    providerId: record.providerId,
    providerProductId: record.providerProductId,
  };
}

export { releaseProductStock };
