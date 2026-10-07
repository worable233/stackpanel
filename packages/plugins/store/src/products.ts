import type { HttpReply, HttpRequest } from '@stackpanel/sdk';
import { EXTENSION_POINTS, isExtensionNotFound } from '@stackpanel/sdk';
import type { UpstreamProductSource } from '@stackpanel/sdk';
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

export async function listProducts(req: HttpRequest): Promise<unknown> {
  const { page, pageSize } = parsePagination(req.query);
  const categoryId =
    typeof req.query['categoryId'] === 'string' ? req.query['categoryId'] : undefined;
  const { items, total } = await listActiveProductsPage(page, pageSize, categoryId);
  return { products: items.map(toSummary), total, page, pageSize };
}

export async function getProduct(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const product = await getProductRecord(id);
  if (!product || product.status !== 'ACTIVE') throw new StoreError(404, '商品不存在');
  return { product: { ...toSummary(product), metadata: publicMetadata(product.metadata) } };
}

/** 公开商品只暴露面向顾客的字段（specs/checkoutConfig），隐藏上游同步内部数据。 */
function publicMetadata(metadata: unknown): Record<string, unknown> | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return null;
  const keep: Record<string, unknown> = {};
  if (record['specs'] !== undefined) keep['specs'] = record['specs'];
  if (record['checkoutConfig'] !== undefined) keep['checkoutConfig'] = record['checkoutConfig'];
  return keep;
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
  const product = await createProductInstance({
    name: input.name,
    description: input.description ?? null,
    price: input.price,
    currency: input.currency.toUpperCase(),
    cost: null,
    originalPrice: null,
    discount: null,
    stock: input.stock,
    status: input.status ?? 'ACTIVE',
    metadata: input.metadata ?? null,
    categoryId: null,
    fulfillmentType: input.fulfillmentType ?? 'instant',
    providerId: input.providerId ?? null,
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
  const next = {
    ...toProductData(existing),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.price !== undefined ? { price: patch.price } : {}),
    ...(patch.stock !== undefined ? { stock: patch.stock } : {}),
    ...(patch.currency !== undefined ? { currency: patch.currency.toUpperCase() } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.metadata !== undefined ? { metadata: patch.metadata ?? null } : {}),
    ...(patch.fulfillmentType !== undefined ? { fulfillmentType: patch.fulfillmentType } : {}),
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
    ...(patch.providerProductId !== undefined
      ? { providerProductId: patch.providerProductId }
      : {}),
  };
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
  validateCheckoutConfig(parsed.data.metadata ?? null);
  validateTypeConfig(parsed.data.fulfillmentType, parsed.data.metadata);
  const product = await createProductInstance({
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    price: parsed.data.price,
    currency: parsed.data.currency.toUpperCase(),
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
  await syncUpstreamAssociation(product.id, parsed.data.providerId, parsed.data.providerProductId);
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
  const next = {
    ...toProductData(existing),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.price !== undefined ? { price: patch.price } : {}),
    ...(patch.stock !== undefined ? { stock: patch.stock } : {}),
    ...(patch.currency !== undefined ? { currency: patch.currency.toUpperCase() } : {}),
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
  try {
    const product = await replaceProduct(id, next);
    await syncUpstreamAssociation(
      product.id,
      patch.providerId ?? product.providerId ?? null,
      patch.providerProductId ?? product.providerProductId ?? null,
    );
    return { product: toSummary(product) };
  } catch (error) {
    if (isExtensionNotFound(error)) throw new StoreError(404, '商品不存在');
    throw error;
  }
}

/**
 * 商品与上游的关联建立/解除：把 providerId/providerProductId 的变化同步给对应
 * 上游插件的 associate/dissociate 钩子（如魔方用它建 ZJMFProductMapping）。
 */
async function syncUpstreamAssociation(
  productId: string,
  providerId: string | null | undefined,
  providerProductId: string | null | undefined,
): Promise<void> {
  const sources = context().getExtensions<UpstreamProductSource>(
    EXTENSION_POINTS.upstreamProductSource,
  );
  if (providerId && providerProductId) {
    const source = sources.find((candidate) => candidate.id === providerId);
    if (source?.associate) {
      const item = await source.get(providerProductId).catch(() => null);
      if (item) await source.associate({ productId, item });
    }
    return;
  }
  // 解除关联：通知所有上游（它们自行判断是否处理过该商品）。
  for (const source of sources) {
    await source.dissociate?.(productId).catch(() => undefined);
  }
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
