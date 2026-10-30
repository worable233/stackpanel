import type { CheckoutSelection, HttpReply, HttpRequest } from '@stackpanel/sdk';
import { StoreError } from './errors';
import { resolveCheckoutPrice, effectiveDiscount } from './pricing';
import { applyDiscount, betterDiscount } from './discount';
import {
  createCartItem,
  deleteCartItems,
  getCartItem,
  getProduct,
  listCartItemsByUser,
  replaceCartItem,
} from './repository';
import { addToCartSchema, parseCheckoutSelection, selectionKey, updateCartQuantitySchema } from './utils';

export async function listCart(req: HttpRequest): Promise<unknown> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const items = await listCartItemsByUser(userId);
  const discount = await effectiveDiscount(userId);
  const rows: Array<{
    id: string;
    productId: string;
    quantity: number;
    config?: unknown;
    product: {
      id: string;
      name: string;
      /** 实付单价（已应用折扣）。 */
      price: number;
      /** 未打折单价；前端用它展示划线原价。 */
      originalPrice: number;
      /** 本行实际生效的折扣百分比（取更优者）；无折扣为 null。 */
      discount: number | null;
      currency: string;
      stock: number;
      status: string;
      createdAt: Date;
    };
    total: number;
    summary?: string;
    unavailableReason?: string;
  }> = [];
  let total = 0;
  for (const item of items) {
    const product = await getProduct(item.productId);
    if (!product) {
      rows.push({
        id: item.id,
        productId: item.productId,
        quantity: item.quantity,
        product: {
          id: item.productId,
          name: '已删除商品',
          price: 0,
          originalPrice: 0,
          discount: null,
          currency: 'CNY',
          stock: 0,
          status: 'DELETED',
          createdAt: new Date(0),
        },
        total: 0,
        unavailableReason: '商品已删除',
      });
      continue;
    }
    let unit = 0;
    let baseUnit = 0;
    let lineDiscount: number | null = null;
    let summary: string | undefined;
    let unavailableReason =
      product.status !== 'ACTIVE'
        ? '商品已下架'
        : product.stock < item.quantity
          ? '库存不足'
          : undefined;
    if (!unavailableReason) {
      try {
        const config = item.config ? parseCheckoutSelection(item.config) : undefined;
        const priced = await resolveCheckoutPrice(product, item.quantity, config);
        // 折扣取更优者、封顶 99%，与下单路径共用 `discount.ts`。
        baseUnit = priced.unit;
        const effective = betterDiscount(product.discount, discount);
        unit = applyDiscount(baseUnit, effective);
        lineDiscount = effective > 0 ? effective : null;
        summary = priced.result?.summary;
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        unavailableReason = error.message;
      }
    }
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
        price: unit,
        originalPrice: baseUnit || product.price,
        discount: lineDiscount,
        currency: product.currency,
        stock: product.stock,
        status: product.status,
        createdAt: product.createdAt,
      },
      total: lineTotal,
      ...(summary ? { summary } : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
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
  const quantity = input.quantity;

  /*
   * Merge into the existing line when the same product is added twice with the
   * same configuration.
   *
   * Without this, clicking 加入购物车 twice produced two identical lines — the
   * customer then pays for and fulfils two services they only meant to buy
   * once. Merging is also what makes the quantity cap below meaningful: the
   * cap must apply to the *combined* quantity, not to each click separately.
   *
   * Identity is `productId` + the normalised selection, so a different cycle or
   * a different OS stays a separate line (they are different purchases).
   */
  const existing = (await listCartItemsByUser(userId)).find(
    (item) =>
      item.productId === input.productId &&
      selectionKey(item.config as CheckoutSelection | null) === selectionKey(config ?? null),
  );
  if (existing) {
    const mergedQuantity = existing.quantity + quantity;
    if (mergedQuantity > product.stock) throw new StoreError(409, '库存不足');
    await resolveCheckoutPrice(product, mergedQuantity, config);
    const updated = await replaceCartItem(existing.id, {
      userId,
      productId: input.productId,
      quantity: mergedQuantity,
      config: existing.config,
    });
    return reply.code(200).send({
      item: { id: updated.id, productId: updated.productId, quantity: updated.quantity },
      merged: true,
      nextPath: '/account/store/cart',
    });
  }

  if (quantity > product.stock) throw new StoreError(409, '库存不足');
  await resolveCheckoutPrice(product, quantity, config);
  const item = await createCartItem({
    userId,
    productId: input.productId,
    quantity,
    config: config ?? null,
  });
  return reply.code(201).send({
    item: { id: item.id, productId: item.productId, quantity: item.quantity },
    nextPath: '/account/store/cart',
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
    await deleteCartItems(
      items.filter((item) => wanted.has(item.productId)).map((item) => item.id),
    );
  }
}
