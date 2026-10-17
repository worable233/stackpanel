import { replaceProduct, listAllProducts } from './repository';
import { context } from './context';
import { tryNormalizeCurrency } from './currency';
import { toProductData } from './products';

/**
 * 存量商品币种的幂等修复（PLAN-currency §6 阶段 4）。
 *
 * - 合法的小写代码 / 已登记别名（`RMB`、`YEN` 等）就地规范化为目录代码。
 * - 无法识别的代码**绝不猜测**：商品置为 `SUSPENDED`，原始值写入
 *   `metadata.currencyIssue` 供管理员人工确认后修复。
 * - 已有订单、购物车和服务实例的历史快照保持只读，不参与重算。
 *
 * 通过 `ctx.state` 标记只跑一次；重复安装/重启不会反复改写数据。
 */

export interface CurrencyMigrationEntry {
  productId: string;
  name: string;
  from: string;
  to: string | null;
  action: 'normalized' | 'suspended';
}

const CURRENCY_MIGRATION_MARKER = 'store:currency:migration:v1';

/**
 * Scan every product once and apply the currency migration rules.
 * Returns the products that changed (empty when the marker shows it has run).
 */
export async function normalizeLegacyProductCurrencies(): Promise<CurrencyMigrationEntry[]> {
  const ctx = context();
  if (await ctx.state.get(CURRENCY_MIGRATION_MARKER)) return [];

  const entries: CurrencyMigrationEntry[] = [];
  const products = await listAllProducts();
  for (const product of products) {
    const normalized = tryNormalizeCurrency(product.currency);
    if (normalized === product.currency) continue;

    if (normalized) {
      await replaceProduct(product.id, {
        ...toProductData(product),
        currency: normalized,
      });
      entries.push({
        productId: product.id,
        name: product.name,
        from: product.currency,
        to: normalized,
        action: 'normalized',
      });
      continue;
    }

    const metadata =
      product.metadata && typeof product.metadata === 'object'
        ? { ...(product.metadata as Record<string, unknown>) }
        : {};
    metadata['currencyIssue'] = {
      original: product.currency,
      reason: 'unknown_currency_code',
      detectedAt: new Date().toISOString(),
    };
    await replaceProduct(product.id, {
      ...toProductData(product),
      status: 'SUSPENDED',
      metadata,
    });
    entries.push({
      productId: product.id,
      name: product.name,
      from: product.currency,
      to: null,
      action: 'suspended',
    });
  }

  await ctx.state.set(CURRENCY_MIGRATION_MARKER, String(Date.now()));
  if (entries.length > 0) {
    ctx.logger.warn(
      `store: currency migration touched ${entries.length} product(s): ` +
        entries
          .map((entry) =>
            entry.action === 'normalized'
              ? `${entry.productId} ${entry.from}->${entry.to}`
              : `${entry.productId} ${entry.from}->SUSPENDED`,
          )
          .join(', '),
    );
  }
  return entries;
}

/** Products currently withheld because of an unresolvable currency code. */
export async function listCurrencyIssues(): Promise<
  Array<{
    productId: string;
    name: string;
    currency: string;
    reason: string;
    detectedAt: string | null;
  }>
> {
  const products = await listAllProducts();
  return products.flatMap((product) => {
    const issue =
      product.metadata && typeof product.metadata === 'object'
        ? (product.metadata as Record<string, unknown>)['currencyIssue']
        : undefined;
    if (!issue || typeof issue !== 'object') return [];
    const detail = issue as Record<string, unknown>;
    return [
      {
        productId: product.id,
        name: product.name,
        currency: product.currency,
        reason: typeof detail['reason'] === 'string' ? detail['reason'] : 'unknown_currency_code',
        detectedAt: typeof detail['detectedAt'] === 'string' ? detail['detectedAt'] : null,
      },
    ];
  });
}
