import type { HttpReply, HttpRequest } from '@stackpanel/sdk';
import { StoreError } from './errors';
import { resolveCheckoutPrice } from './pricing';
import {
  createCartItem,
  deleteCartItems,
  getCartItem,
  getProduct,
  listCartItemsByUser,
  replaceCartItem,
} from './repository';
import { addToCartSchema, parseCheckoutSelection, updateCartQuantitySchema } from './utils';

export async function listCart(req: HttpRequest): Promise<unknown> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const items = await listCartItemsByUser(userId);
  const rows: Array<{
    id: string;
    productId: string;
    quantity: number;
    config?: unknown;
    product: {
      id: string;
      name: string;
      price: number;
      currency: string;
      stock: number;
      status: string;
      createdAt: Date;
    };
    total: number;
    summary?: string;
  }> = [];
  let total = 0;
  for (const item of items) {
    const product = await getProduct(item.productId);
    if (!product) continue;
    const config = item.config ? parseCheckoutSelection(item.config) : undefined;
    const { unit, result } = await resolveCheckoutPrice(product, item.quantity, config);
    const lineTotal = unit * item.quantity;
    total += lineTotal;
    rows.push({
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      ...(item.config ? { config: item.config } : {}),
      product: {
        id: product.id,
        name: product.name,
        price: product.price,
        currency: product.currency,
        stock: product.stock,
        status: product.status,
        createdAt: product.createdAt,
      },
      total: lineTotal,
      ...(result?.summary ? { summary: result.summary } : {}),
    });
  }
  return { items: rows, total };
}

export async function addToCart(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const parsed = addToCartSchema.safeParse(req.body);
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const input = parsed.data;
  const product = await getProduct(input.productId);
  if (!product || product.status !== 'ACTIVE' || product.stock <= 0) {
    throw new StoreError(409, '商品不可购买');
  }
  const config = input.config ? parseCheckoutSelection(input.config) : undefined;
  const quantity = Math.min(input.quantity, product.stock);
  const item = await createCartItem({
    userId,
    productId: input.productId,
    quantity,
    config: config ?? null,
  });
  return reply.code(201).send({
    item: { id: item.id, productId: item.productId, quantity: item.quantity },
    nextPath: '/shop/cart',
  });
}

export async function updateCartQuantity(req: HttpRequest): Promise<unknown> {
  const parsed = updateCartQuantitySchema.safeParse(req.body);
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const item = await getCartItem(id);
  if (!item || item.userId !== userId) throw new StoreError(404, '购物车项不存在');
  const product = await getProduct(item.productId);
  if (!product || product.status !== 'ACTIVE' || product.stock < parsed.data.quantity) {
    throw new StoreError(409, '库存不足');
  }
  const updated = await replaceCartItem(id, { ...item, quantity: parsed.data.quantity });
  return { item: { id: updated.id, productId: updated.productId, quantity: updated.quantity } };
}

export async function removeCartItem(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const item = await getCartItem(id);
  if (item && item.userId === userId) await deleteCartItems([id]);
  return reply.code(204).send();
}

export async function removePurchasedCartItems(
  userId: string,
  cart?: { cartItemIds?: string[]; productIds?: string[] },
): Promise<void> {
  if (!cart) return;
  if (cart.cartItemIds?.length) {
    const items = await listCartItemsByUser(userId);
    const wanted = new Set(cart.cartItemIds);
    await deleteCartItems(items.filter((item) => wanted.has(item.id)).map((item) => item.id));
  } else if (cart.productIds?.length) {
    const items = await listCartItemsByUser(userId);
    const wanted = new Set(cart.productIds);
    await deleteCartItems(items.filter((item) => wanted.has(item.productId)).map((item) => item.id));
  }
}
