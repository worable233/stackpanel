import type { FxQuote, PluginContext } from '@stackpanel/sdk';
import { CurrencyError, assertCurrency, formatMinorCurrency } from '@stackpanel/sdk';
import { context } from './context';
import { StoreError } from './errors';
import { cartItemModel, serviceInstanceModel } from './data';
import { listAllOrdersPage } from './repository';

/**
 * Currency rules for the store plugin (PLAN-currency §4.2 / §4.3).
 *
 * The kernel owns the catalog, precision and settlement setting; the store only
 * enforces the *business* rules on top: a product currency must be a catalog
 * code, it becomes immutable once the product is referenced by a transaction,
 * and every order total is converted to the configured settlement currency.
 */

/** Validate a product currency against the kernel catalog, returning the normalized code. */
export async function resolveProductCurrency(code: unknown): Promise<string> {
  try {
    const definition = await context().currency.requireEnabled(String(code ?? ''));
    return definition.code;
  } catch (error) {
    throw toStoreError(error);
  }
}

/** Parse a major-unit amount using the currency's minor unit (admin input). */
export function parseMajorAmount(value: number | string, code: string): number {
  try {
    return context().currency.toMinor(value, code);
  } catch (error) {
    throw toStoreError(error);
  }
}

/** Display an integer minor-unit amount for notifications/audit text. */
export function formatStoreMoney(amountMinor: number, code: string): string {
  try {
    return formatMinorCurrency(amountMinor, code, 'zh-CN');
  } catch {
    return `${amountMinor} ${code}`;
  }
}

/**
 * Render an order's original and settlement amounts in one human-readable
 * string (plan §6 phase 3). When both sides use the same currency the pair
 * collapses to a single amount so nothing reads as duplicated.
 */
export function formatAmountPair(input: {
  total: number;
  currency: string;
  settlementTotal: number;
  settlementCurrency: string;
}): string {
  const original = formatStoreMoney(input.total, input.currency);
  if (sameCurrency(input.currency, input.settlementCurrency)) return original;
  const settled = formatStoreMoney(input.settlementTotal, input.settlementCurrency);
  return `${original}（结算 ${settled}）`;
}

/**
 * Convert an order total to the platform settlement currency. Uses the kernel
 * FX service, which validates both currencies, the rate and its expiry, and
 * returns a frozen snapshot to persist on the order.
 */
export async function quoteSettlement(
  ctx: PluginContext,
  currency: string,
  amountMinor: number,
): Promise<FxQuote> {
  try {
    return await ctx.fx.quoteToSettlement(currency, amountMinor);
  } catch (error) {
    throw toStoreError(error);
  }
}

/** Re-throw a branded kernel currency error as the store's deterministic error. */
function toStoreError(error: unknown): StoreError {
  // Preserve the kernel's stable code (`currency.*`) instead of collapsing it
  // into a generic store code — clients branch on it.
  if (error instanceof CurrencyError) {
    return new StoreError(error.status, error.message, error.code);
  }
  if (error instanceof StoreError) return error;
  throw error;
}

/**
 * True when a product is referenced by any transaction (order line, cart item
 * or service instance). Once true its currency may not change in place — the
 * operator must copy it into a new product instead (plan §4.2 / §5.2).
 */
export async function isProductCurrencyLocked(productId: string): Promise<boolean> {
  const ext = context().extensions;
  const [cart, services] = await Promise.all([
    ext.list<{ productId: string }>(cartItemModel, {
      where: { productId: { eq: productId } },
      page: 1,
      pageSize: 1,
    }),
    ext.list<{ productId: string }>(serviceInstanceModel, {
      where: { productId: { eq: productId } },
      page: 1,
      pageSize: 1,
    }),
  ]);
  if (cart.total > 0 || services.total > 0) return true;
  // Order lines live in a JSON column, so there is no indexable `productId`
  // filter. Page through every order (this only runs when an operator changes a
  // product's currency, which is rare) and stop at the first match — a partial
  // scan could wrongly allow changing a currency that an old order already
  // recorded.
  const pageSize = 200;
  for (let page = 1; ; page += 1) {
    const { items, total } = await listAllOrdersPage(page, pageSize);
    const hit = items.some((order) =>
      ((order.items as { items?: Array<{ productId?: string }> } | null)?.items ?? []).some(
        (line) => line.productId === productId,
      ),
    );
    if (hit) return true;
    if (items.length < pageSize || page * pageSize >= total) return false;
  }
}

/** Guard helper: throw `currency.product_immutable` when the currency may not change. */
export async function assertCurrencyMutable(productId: string): Promise<void> {
  if (await isProductCurrencyLocked(productId)) {
    throw new StoreError(409, '商品已产生交易，不能修改币种', 'currency.product_immutable');
  }
}

/** Normalize an arbitrary value to a catalog code, or null. */
export function tryNormalizeCurrency(code: unknown): string | null {
  try {
    return assertCurrency(code);
  } catch {
    return null;
  }
}

/** True when two currency codes refer to the same catalog currency. */
export function sameCurrency(left: unknown, right: unknown): boolean {
  const a = tryNormalizeCurrency(left);
  const b = tryNormalizeCurrency(right);
  return a !== null && a === b;
}
