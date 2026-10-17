import { SectionTitle } from '@stackpanel/ui';
import {
  formatMinorCurrency,
  minorUnitFor,
  minorUnitsToPlainString,
} from '@stackpanel/sdk';
import type {
  AccountPageComponentProps,
  AdminWidgetProps,
  FinderProvider,
  FrontendPackage,
  FrontendPageComponent,
} from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { ArrowUpRight, PackageOpen } from 'lucide-react';
import { z } from 'zod';

interface StoreProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  status: string;
  metadata: Record<string, unknown> | null;
  fulfillmentType?: string;
  providerId?: string | null;
  providerProductId?: string | null;
  categoryId?: string | null;
}

interface CheckoutCycle {
  id: string;
  label: string;
  price: number;
  renewPrice?: number;
  months?: number;
}

interface CheckoutChoice {
  id: string;
  label: string;
  price?: number;
  prices?: Record<string, number>;
  requires?: Record<string, string | string[]>;
  recurring?: boolean;
}

interface CheckoutVisibility {
  field: string;
  equals?: unknown;
  in?: unknown[];
}

interface CheckoutOption {
  id: string;
  label: string;
  type: 'select' | 'quantity';
  group?: string;
  help?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  defaultChoice?: string;
  visibleWhen?: CheckoutVisibility;
  choices?: CheckoutChoice[];
}

interface CheckoutConfig {
  cycles: CheckoutCycle[];
  options: CheckoutOption[];
}

interface PricePreview {
  productId: string;
  price: number;
  currency: string;
  quantity: number;
  total: number;
  settlementCurrency?: string;
  settlementTotal?: number;
  fxRate?: number | null;
  renewPrice?: number;
  breakdown?: Array<{ label: string; value: string; price?: number }>;
  summary?: string;
}

interface StorePayment {
  id: string;
  providerId: string | null;
  paymentMethod: string | null;
  paymentUrl: string | null;
  status: string;
}

interface StoreOrder {
  id: string;
  total: number;
  currency: string;
  /** Frozen settlement snapshot (plan §5.2). */
  settlementCurrency?: string;
  settlementTotal?: number;
  status: string;
  payment?: StorePayment | null;
}

interface CartItem {
  id: string;
  productId: string;
  quantity: number;
  product: {
    id: string;
    name: string;
    price: number;
    currency: string;
    stock: number;
    status: string;
    createdAt: string;
  };
  total: number;
}

interface CartPayload {
  items: CartItem[];
  total: number;
}

interface CatalogCategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  productCount: number;
  children: CatalogCategoryNode[];
}

interface CatalogEntry {
  catalog: { id: string; categoryIds: string[]; shelfStatus: string; sortOrder: number };
  product: {
    id: string;
    name: string;
    description: string | null;
    price: number;
    currency: string;
    stock: number;
    status: string;
  };
}

interface CatalogProductsResult {
  products: CatalogEntry[];
  total: number;
  page: number;
  pageSize: number;
  categoryId: string | null;
}

const storeProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.number(),
  currency: z.string(),
  stock: z.number(),
  status: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  cost: z.number().nullable(),
  originalPrice: z.number().nullable(),
  discount: z.number().nullable(),
  fulfillmentType: z.string(),
  providerId: z.string().nullable(),
  providerProductId: z.string().nullable(),
});

/**
 * 公开展厅 / 账户商城商品 DTO（`PublicProduct` / `PurchasableProduct`）。
 * 公开接口不下发成本价、上游 provider 标识与内部 metadata（PLAN §4.3），
 * 因此这里必须是独立的最小 schema，不能复用管理端 `storeProductSchema`。
 */
const storePublicProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.number(),
  currency: z.string(),
  stock: z.number(),
  status: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  originalPrice: z.number().nullable(),
  discount: z.number().nullable(),
  fulfillmentType: z.string(),
  categoryId: z.string().nullable(),
});

const storePurchasableProductSchema = storePublicProductSchema.extend({
  purchasable: z.boolean(),
  unavailableReason: z.enum(['inactive', 'out_of_stock', 'forbidden']).nullable(),
});

const cartSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      productId: z.string(),
      quantity: z.number(),
      product: z.object({
        id: z.string(),
        name: z.string(),
        price: z.number(),
        currency: z.string(),
        stock: z.number(),
        status: z.string(),
        createdAt: z.string(),
      }),
      total: z.number(),
      config: z.unknown().optional(),
      summary: z.string().optional(),
    }),
  ),
  total: z.number(),
});

const pricePreviewSchema = z.object({
  productId: z.string(),
  price: z.number(),
  currency: z.string(),
  quantity: z.number(),
  total: z.number(),
  // Settlement preview: absent when no usable FX rate is configured.
  settlementCurrency: z.string().optional(),
  settlementTotal: z.number().optional(),
  fxRate: z.number().nullable().optional(),
  renewPrice: z.number().optional(),
  breakdown: z
    .array(z.object({ label: z.string(), value: z.string(), price: z.number().optional() }))
    .optional(),
  summary: z.string().optional(),
});

const storeOrderSchema = z.object({
  id: z.string(),
  total: z.number(),
  currency: z.string(),
  settlementCurrency: z.string().optional(),
  settlementTotal: z.number().optional(),
  status: z.string(),
  payment: z
    .object({
      id: z.string(),
      providerId: z.string().nullable(),
      paymentMethod: z.string().nullable(),
      paymentUrl: z.string().nullable(),
      status: z.string(),
    })
    .nullable()
    .optional(),
});

const paymentMethodsSchema = z.object({
  wallet: z.object({ id: z.literal('wallet'), label: z.string() }),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      methods: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          topUpAmounts: z.array(z.number()).optional(),
        }),
      ),
    }),
  ),
});

const currencyDefinitionSchema = z.object({
  code: z.string(),
  name: z.string(),
  symbol: z.string(),
  minorUnit: z.number(),
});
const currencyDefinitionListSchema = z.object({ currencies: z.array(currencyDefinitionSchema) });

const productListSchema = z.object({ products: z.array(storeProductSchema) });
const publicProductListSchema = z.object({ products: z.array(storePublicProductSchema) });
const publicProductSchema = z.object({ product: storePublicProductSchema });
const purchasableProductListSchema = z.object({
  products: z.array(storePurchasableProductSchema),
});
const purchasableProductSchema = z.object({ product: storePurchasableProductSchema });
const orderListSchema = z.object({ orders: z.array(storeOrderSchema) });

const changeQuoteSchema = z.object({
  from: z.number(),
  to: z.number(),
  diff: z.number(),
  currency: z.string(),
  summary: z.string().optional(),
});

const productTypeListSchema = z.object({
  types: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      pluginId: z.string(),
      configFields: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          type: z.enum(['text', 'textarea', 'number', 'select', 'boolean']),
          required: z.boolean().optional(),
          placeholder: z.string().optional(),
          min: z.number().optional(),
          max: z.number().optional(),
          options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
        }),
      ),
    }),
  ),
});

const upstreamSourceListSchema = z.object({
  sources: z.array(z.object({ id: z.string(), name: z.string() })),
});

const serviceSummarySchema = z.object({
  id: z.string(),
  productName: z.string(),
  fulfillmentType: z.string(),
  status: z.string(),
  runtime: z.unknown().nullable(),
  amount: z.number(),
  currency: z.string(),
  expiresAt: z.string().nullable(),
  provisionedAt: z.string().nullable(),
  createdAt: z.string(),
});
const serviceListSchema = z.object({ services: z.array(serviceSummarySchema) });
const serviceFieldSchema = z.object({
  label: z.string(),
  value: z.string(),
  secret: z.boolean().optional(),
  copyable: z.boolean().optional(),
});
const serviceActionParamSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['text', 'password', 'number', 'select', 'textarea']),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number()]).optional(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().optional(),
  placeholder: z.string().optional(),
});
const serviceActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  danger: z.boolean().optional(),
  confirm: z.boolean().optional(),
  params: z.array(serviceActionParamSchema).optional(),
});
const serviceDetailSchema = z.object({
  title: z.string().optional(),
  status: z.string().optional(),
  statusLabel: z.string().optional(),
  fields: z.array(serviceFieldSchema),
  actions: z.array(serviceActionSchema).optional(),
});
const serviceSchema = z.object({
  service: z.object({
    id: z.string(),
    productId: z.string().optional(),
    productName: z.string(),
    fulfillmentType: z.string(),
    providerId: z.string().nullable(),
    providerServiceId: z.string().nullable(),
    status: z.string(),
    statusLabel: z.string().nullable(),
    title: z.string(),
    runtime: z.unknown().nullable(),
    amount: z.number(),
    currency: z.string(),
    expiresAt: z.string().nullable(),
    provisionedAt: z.string().nullable(),
    createdAt: z.string(),
    detail: serviceDetailSchema,
  }),
});
const serviceMetricsSchema = z.object({
  metrics: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      unit: z.string(),
      color: z.string().optional(),
      points: z.array(z.object({ t: z.number(), v: z.number() })),
    }),
  ),
});

const resourceKindSchema = z.object({
  id: z.string(),
  label: z.string(),
  creatable: z.boolean().optional(),
  createParams: z.array(serviceActionParamSchema).optional(),
  columns: z.array(z.object({ key: z.string(), label: z.string() })).optional(),
  rowActions: z.array(serviceActionSchema).optional(),
  visibleWhen: z
    .object({
      field: z.string(),
      equals: z.unknown().optional(),
      in: z.array(z.unknown()).optional(),
    })
    .optional(),
});
const resourceKindsSchema = z.object({ kinds: z.array(resourceKindSchema) });
const resourceListSchema = z.object({
  resources: z.array(
    z.object({
      id: z.string(),
      fields: z.record(z.string(), z.string()),
      actions: z.array(serviceActionSchema).optional(),
    }),
  ),
});

const settingsSchema = {
  groups: [
    {
      id: 'shop',
      label: '商店',
      fields: [
        {
          type: 'number',
          name: 'productsPerPage',
          label: '每页商品数',
          default: 12,
          min: 1,
          max: 60,
        },
        {
          type: 'boolean',
          name: 'showAllProducts',
          label: '前台展示全部服务',
          description: '开启后，前台除分类外还会显示「全部分类」，展示未分类商品。',
          default: false,
        },
      ],
    },
  ],
} satisfies NonNullable<FrontendPackage['settingsSchema']>;

/** Dependency-free inline icons — the bundle keeps no icon dependency. */
import {
  ArrowRight,
  Check,
  Layers,
  Minus,
  Package,
  ShoppingCart,
  Trash2,
  Wallet,
} from 'lucide-react';

const ICONS: Record<string, ReactElement> = {
  arrow: <ArrowRight />,
  cart: <ShoppingCart />,
  wallet: <Wallet />,
  minus: <Minus />,
  trash: <Trash2 />,
  check: <Check />,
  package: <Package />,
  layers: <Layers />,
};

function Icon({ name }: { name: string }): ReactElement {
  return (
    <span
      className="inline-flex size-[1.15em] shrink-0 items-center justify-center leading-none [&_svg]:size-full"
      aria-hidden="true"
    >
      {ICONS[name]}
    </span>
  );
}

/** Format minor units via the kernel catalog (never `/100` or a CNY branch). */
function money(amount: number, currency: string): string {
  try {
    return formatMinorCurrency(amount, currency, 'zh-CN');
  } catch {
    return `${amount} ${currency}`;
  }
}

const FULFILLMENT_LABELS: Record<string, string> = {
  upstream_service: '云服务器',
  card: '发卡',
  instant: '即时发放',
  api_token: 'API 额度',
  membership: '会员',
  physical: '实物',
  donation: '赞助',
  topup: '流量卡',
};

function fulfillmentLabel(type: string): string {
  return FULFILLMENT_LABELS[type] ?? type;
}

function PriceTag({ amount, currency }: { amount: number; currency: string }): ReactElement {
  const minorUnit = (() => {
    try {
      return minorUnitFor(currency);
    } catch {
      return 2;
    }
  })();
  const plain = minorUnitsToPlainString(amount, currency);
  const [int, dec] = minorUnit > 0 ? plain.split('.') : [plain, ''];
  return (
    <span className="font-mono font-bold tracking-tight tabular-nums">
      <span className="align-super text-[0.65em] font-medium opacity-80">{currency} </span>
      <span>{int}</span>
      {minorUnit > 0 ? <span className="text-[0.75em] opacity-80">.{dec}</span> : null}
    </span>
  );
}

function StockBadge({ stock }: { stock: number }): ReactElement {
  return stock > 0 ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
      <span className="size-1.5 rounded-full bg-current" />
      有货
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      <span className="size-1.5 rounded-full bg-current" />
      暂时缺货
    </span>
  );
}

function ProductCard({ product }: { product: StoreProduct }): ReactElement {
  return (
    <Link
      href={`/shop/${product.id}`}
      className="group relative flex flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-md"
    >
      <div
        className="pointer-events-none absolute -right-20 -top-20 size-48 rounded-full bg-primary/10 blur-3xl opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden="true"
      />
      <div className="flex items-start justify-between gap-4 p-5 pb-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform group-hover:scale-110">
          <Icon name="package" />
        </div>
        <StockBadge stock={product.stock} />
      </div>
      <div className="flex flex-1 flex-col px-5">
        <h2 className="text-base font-semibold tracking-tight transition-colors group-hover:text-primary">
          {product.name}
        </h2>
        {product.description ? (
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
            {product.description}
          </p>
        ) : null}
      </div>
      <div className="relative mt-5 flex items-center justify-between gap-3 border-t border-border/60 px-5 py-4">
        <div>
          <PriceTag amount={product.price} currency={product.currency} />
          <p className="mt-0.5 text-xs text-muted-foreground">
            {money(product.price, product.currency)}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors group-hover:text-primary">
          查看详情
          <span className="transition-transform group-hover:translate-x-0.5">
            <Icon name="arrow" />
          </span>
        </span>
      </div>
    </Link>
  );
}

function ProductListPage(props: Parameters<FrontendPageComponent>[0]): ReactElement {
  const products = (props.data.products as StoreProduct[] | undefined) ?? [];
  const categories = (props.data.categories as CatalogCategoryNode[] | undefined) ?? [];
  const catalogResult = props.data.catalogProducts as CatalogProductsResult | undefined;
  const activeId = catalogResult?.categoryId ?? undefined;
  const entries = catalogResult?.products ?? [];
  const total = catalogResult?.total ?? entries.length;
  const hasCatalog = categories.length > 0;
  const settings = props.settings as { shop?: { showAllProducts?: boolean } };
  const showAll = settings.shop?.showAllProducts === true;
  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
      <div className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 -z-10 [background:radial-gradient(28rem_10rem_at_20%_0%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent)]"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-20 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:3rem_3rem] [mask-image:radial-gradient(ellipse_60%_60%_at_30%_0%,#000_50%,transparent_100%)]"
          aria-hidden="true"
        />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
              {activeId ? findCategoryName(categories, activeId) : '服务目录'}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/shop/cart"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-4 text-sm font-semibold text-background shadow-sm transition-opacity hover:opacity-90"
            >
              <Icon name="cart" />
              购物车
            </Link>
          </div>
        </div>
      </div>
      {hasCatalog ? (
        <div className="mt-10 grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="h-fit rounded-2xl border bg-card p-4 shadow-sm lg:sticky lg:top-20">
            <nav aria-label="商品分类">
              {showAll ? (
                <Link
                  href="/shop?showAll=1"
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-muted ${
                    !activeId ? 'bg-muted font-medium' : 'text-muted-foreground'
                  }`}
                >
                  <span className="flex items-center text-primary">
                    <Icon name="layers" />
                  </span>
                  全部分类
                </Link>
              ) : null}
              <ul className="mt-1 space-y-0.5">
                {categories.map((node) => (
                  <CategoryLink key={node.id} node={node} activeId={activeId} />
                ))}
              </ul>
            </nav>
          </aside>
          <section>
            {activeId ? <CategoryBreadcrumb categories={categories} activeId={activeId} /> : null}
            {entries.length ? (
              <>
                <p className="mb-4 text-sm text-muted-foreground">共 {total} 件服务</p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {entries.map(({ product }) => (
                    <ProductCard key={product.id} product={toStoreProduct(product)} />
                  ))}
                </div>
                {catalogResult ? (
                  <Pager
                    page={catalogResult.page}
                    pageSize={catalogResult.pageSize}
                    total={catalogResult.total}
                    categoryId={activeId}
                  />
                ) : null}
              </>
            ) : (
              <Empty text="该分类下暂无在售服务" />
            )}
          </section>
        </div>
      ) : products.length ? (
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      ) : (
        <div className="mt-10">
          <Empty text="暂无在售服务" />
        </div>
      )}
    </main>
  );
}

/** Find a category name in the tree (used for the page heading). */
function findCategoryName(categories: readonly CatalogCategoryNode[], activeId: string): string {
  const found = findCategoryNode(categories, activeId);
  return found?.name ?? '服务目录';
}

function findCategoryNode(
  nodes: readonly CatalogCategoryNode[],
  activeId: string,
): CatalogCategoryNode | null {
  for (const node of nodes) {
    if (node.id === activeId) return node;
    const viaChild = findCategoryNode(node.children, activeId);
    if (viaChild) return viaChild;
  }
  return null;
}

function toStoreProduct(product: CatalogEntry['product']): StoreProduct {
  return { ...product, metadata: null };
}

/** Resolve the ancestor path (root first) ending at `activeId`. */
function findCategoryPath(
  categories: readonly CatalogCategoryNode[],
  activeId: string,
): CatalogCategoryNode[] | null {
  for (const node of categories) {
    if (node.id === activeId) return [node];
    const viaChild = findCategoryPathInTree(node.children, activeId);
    if (viaChild) return [node, ...viaChild];
  }
  return null;
}

function findCategoryPathInTree(
  nodes: readonly CatalogCategoryNode[],
  activeId: string,
): CatalogCategoryNode[] | null {
  for (const node of nodes) {
    if (node.id === activeId) return [node];
    const viaChild = findCategoryPathInTree(node.children, activeId);
    if (viaChild) return [node, ...viaChild];
  }
  return null;
}

function CategoryLink({
  node,
  activeId,
}: {
  node: CatalogCategoryNode;
  activeId?: string;
}): ReactElement {
  const isActive = activeId === node.id;
  return (
    <li>
      <Link
        href={node.id ? `/shop?categoryId=${node.id}` : '/shop'}
        className={`flex items-center justify-between gap-2 rounded-lg py-1.5 pl-3 pr-2 text-sm transition-colors hover:bg-muted ${
          isActive ? 'bg-muted font-medium' : 'text-muted-foreground'
        }`}
      >
        <span className="truncate">
          {node.icon ? `${node.icon} ` : ''}
          {node.name}
        </span>
        {node.productCount > 0 ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs tabular-nums">
            {node.productCount}
          </span>
        ) : null}
      </Link>
      {node.children.length ? (
        <ul className="ml-4">
          {node.children.map((child) => (
            <CategoryLink key={child.id} node={child} activeId={activeId} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function CategoryBreadcrumb({
  categories,
  activeId,
}: {
  categories: readonly CatalogCategoryNode[];
  activeId: string;
}): ReactElement | null {
  const path = findCategoryPath(categories, activeId);
  if (!path) return null;
  return (
    <nav
      aria-label="面包屑"
      className="mb-4 flex flex-wrap items-center gap-1 text-sm text-muted-foreground"
    >
      <Link href="/shop" className="hover:text-foreground hover:underline">
        全部服务
      </Link>
      {path.map((node) =>
        node.id === activeId ? (
          <span key={node.id} className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <span className="font-medium text-foreground">{node.name}</span>
          </span>
        ) : (
          <span key={node.id} className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <Link
              href={`/shop?categoryId=${node.id}`}
              className="hover:text-foreground hover:underline"
            >
              {node.name}
            </Link>
          </span>
        ),
      )}
    </nav>
  );
}

function Pager({
  page,
  pageSize,
  total,
  categoryId,
}: {
  page: number;
  pageSize: number;
  total: number;
  categoryId?: string;
}): ReactElement | null {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const categoryQuery = categoryId ? `categoryId=${encodeURIComponent(categoryId)}&` : '';
  return (
    <nav className="mt-8 flex items-center justify-between border-t pt-4 text-sm">
      <span className="text-muted-foreground">
        共 {total} 件 · 第 {page} / {pages} 页
      </span>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link
            href={`/shop?${categoryQuery}page=${page - 1}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border bg-card px-3.5 text-sm font-medium shadow-sm transition-colors hover:bg-muted"
          >
            <span className="rotate-180">
              <Icon name="arrow" />
            </span>
            上一页
          </Link>
        ) : (
          <span className="inline-flex h-9 items-center gap-1.5 rounded-xl border bg-muted px-3.5 text-sm text-muted-foreground">
            <span className="rotate-180 opacity-50">
              <Icon name="arrow" />
            </span>
            上一页
          </span>
        )}
        {page < pages ? (
          <Link
            href={`/shop?${categoryQuery}page=${page + 1}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border bg-card px-3.5 text-sm font-medium shadow-sm transition-colors hover:bg-muted"
          >
            下一页
            <Icon name="arrow" />
          </Link>
        ) : (
          <span className="inline-flex h-9 items-center gap-1.5 rounded-xl border bg-muted px-3.5 text-sm text-muted-foreground">
            下一页
            <span className="opacity-50">
              <Icon name="arrow" />
            </span>
          </span>
        )}
      </div>
    </nav>
  );
}

interface Selection {
  cycle?: string;
  selections?: Record<string, string | number>;
}

/** 从商品 metadata 读取结账配置。 */
function readCheckoutConfig(metadata: Record<string, unknown> | null): CheckoutConfig | null {
  const config = metadata?.['checkoutConfig'];
  if (!config || typeof config !== 'object') return null;
  const candidate = config as Partial<CheckoutConfig>;
  if (!Array.isArray(candidate.cycles) || candidate.cycles.length === 0) return null;
  return {
    cycles: candidate.cycles.filter((cycle): cycle is CheckoutCycle =>
      Boolean(cycle && typeof cycle.id === 'string'),
    ),
    options: Array.isArray(candidate.options) ? (candidate.options as CheckoutOption[]) : [],
  };
}

/** 条件是否命中：`equals` 精确、`in` 任一命中；都缺省表示「非空即显示」。 */
function matchesVisibility(
  value: string | number | undefined,
  condition: CheckoutVisibility,
): boolean {
  if (condition.equals === undefined && (!condition.in || condition.in.length === 0)) {
    return value !== undefined && value !== null && value !== '';
  }
  if (value === undefined || value === null) return false;
  if (condition.equals !== undefined && String(value) === String(condition.equals)) return true;
  return Boolean(condition.in?.some((candidate) => String(candidate) === String(value)));
}

/** 当前选择下某配置项可用的档位（按 `requires` 层级联动过滤）。 */
function allowedChoices(
  option: CheckoutOption,
  selections: Record<string, string | number>,
  cycle: string,
): CheckoutChoice[] {
  return (option.choices ?? []).filter((choice) => {
    if (!choice.requires) return true;
    return Object.entries(choice.requires).every(([field, expected]) => {
      const value = field === 'cycle' ? cycle : selections[field];
      const allowed = Array.isArray(expected) ? expected : [expected];
      return (
        value !== undefined && allowed.some((candidate) => String(candidate) === String(value))
      );
    });
  });
}

function optionVisible(
  option: CheckoutOption,
  selections: Record<string, string | number>,
  cycle: string,
): boolean {
  if (!option.visibleWhen) return true;
  const value = option.visibleWhen.field === 'cycle' ? cycle : selections[option.visibleWhen.field];
  return matchesVisibility(value, option.visibleWhen);
}

/** 默认选择：第一个周期；每个可见 select 选项选第一个可用档位；quantity 取 min。 */
function defaultSelection(config: CheckoutConfig | null): Selection | null {
  if (!config) return null;
  const cycle = config.cycles[0]?.id ?? '';
  const selections: Record<string, string | number> = {};
  for (const option of config.options) {
    if (!optionVisible(option, selections, cycle)) continue;
    const choices = allowedChoices(option, selections, cycle);
    const preferred =
      (option.defaultChoice && choices.find((choice) => choice.id === option.defaultChoice)) ||
      choices[0];
    if (option.type === 'quantity') {
      const min = option.min ?? preferred?.qtyMin ?? 0;
      if (preferred) selections[option.id] = min;
    } else if (preferred) {
      selections[option.id] = preferred.id;
    }
  }
  return { cycle, ...(Object.keys(selections).length ? { selections } : {}) };
}

/** 某档位在当前周期下的单价增量（minor）；无则回退 price。 */
function choicePrice(choice: CheckoutChoice, cycleId: string): number | undefined {
  return choice.prices?.[cycleId] ?? choice.price;
}

/** 从 GET 表单 query 重建选择（字段名：cycle + cfg_<optionId>）。 */
function selectionFromQuery(
  query: Record<string, string | string[] | undefined>,
): Selection | null {
  const cycle = typeof query['cycle'] === 'string' && query['cycle'] ? query['cycle'] : undefined;
  const selections: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('cfg_')) continue;
    const optionId = key.slice(4);
    if (!optionId || typeof value !== 'string' || value === '') continue;
    selections[optionId] = /^\d+$/.test(value) ? Number(value) : value;
  }
  if (!cycle && Object.keys(selections).length === 0) return null;
  return {
    ...(cycle ? { cycle } : {}),
    ...(Object.keys(selections).length ? { selections } : {}),
  };
}

/** 计算价格表单：GET 提交到本页，query 由 pricePreview finder 读取。 */
function CheckoutConfigForm({
  product,
  config,
  selection,
}: {
  product: StoreProduct;
  config: CheckoutConfig;
  selection: Selection | null;
}): ReactElement {
  const sel = selection?.selections ?? {};
  const cycle = selection?.cycle ?? config.cycles[0]?.id ?? '';
  // 按 group 归组（无 group 的项归入默认组），保留声明顺序。
  const groups: Array<{ name: string; options: CheckoutOption[] }> = [];
  for (const option of config.options) {
    if (!optionVisible(option, sel, cycle)) continue;
    const name = option.group ?? '';
    const bucket = groups.find((candidate) => candidate.name === name);
    if (bucket) bucket.options.push(option);
    else groups.push({ name, options: [option] });
  }
  return (
    <form method="get" action={`/shop/${product.id}`} className="mt-6 space-y-5 border-t pt-5">
      <div className="grid gap-1.5">
        <label className="text-sm font-medium">计费周期</label>
        <select
          name="cycle"
          defaultValue={cycle}
          className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
        >
          {config.cycles.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}（{money(item.price, product.currency)}）
            </option>
          ))}
        </select>
      </div>
      {groups.map((group) => (
        <fieldset key={group.name || 'default'} className="space-y-4 rounded-xl border p-4">
          {group.name ? (
            <legend className="px-1 text-xs font-semibold text-muted-foreground">
              {group.name}
            </legend>
          ) : null}
          {group.options.map((option) => {
            const current = sel[option.id];
            if (option.type === 'quantity') {
              const unit = choicePrice(
                allowedChoices(option, sel, cycle)[0] ?? { id: '', label: '' },
                cycle,
              );
              return (
                <div key={option.id} className="grid gap-1.5">
                  <label className="text-sm font-medium">
                    {option.label}
                    {option.unit ? `（${option.unit}）` : ''}
                  </label>
                  <input
                    name={`cfg_${option.id}`}
                    type="number"
                    min={option.min ?? 0}
                    max={option.max ?? undefined}
                    step={option.step ?? 1}
                    defaultValue={typeof current === 'number' ? current : (option.min ?? 0)}
                    className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
                  />
                  {unit != null ? (
                    <span className="text-[11px] text-muted-foreground">
                      单价 {money(unit, product.currency)}/{option.unit ?? '单位'}
                    </span>
                  ) : null}
                </div>
              );
            }
            const choices = allowedChoices(option, sel, cycle);
            return (
              <div key={option.id} className="grid gap-1.5">
                <label className="text-sm font-medium">
                  {option.label}
                  {option.required ? ' *' : ''}
                </label>
                <select
                  name={`cfg_${option.id}`}
                  defaultValue={typeof current === 'string' ? current : (choices[0]?.id ?? '')}
                  className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
                >
                  {choices.map((choice) => {
                    const price = choicePrice(choice, cycle);
                    return (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                        {price != null && price > 0
                          ? `（+${money(price, product.currency)}${choice.recurring === false ? ' 首期' : ''}）`
                          : ''}
                      </option>
                    );
                  })}
                </select>
                {option.help ? (
                  <span className="text-[11px] text-muted-foreground">{option.help}</span>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      ))}
      <button
        type="submit"
        className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border bg-background px-4 text-sm font-semibold transition-colors hover:bg-muted"
      >
        计算价格
      </button>
    </form>
  );
}

/** 配置价格预览（来自服务端 pricePreview finder）。 */
function CheckoutPricePreview({
  preview,
  currency,
}: {
  preview: PricePreview;
  currency: string;
}): ReactElement | null {
  return (
    <div className="mt-4 rounded-xl border bg-muted/40 p-4 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground">配置价格</span>
        <span className="text-xl font-semibold">{money(preview.total, currency)}</span>
      </div>
      {preview.settlementCurrency &&
      preview.settlementTotal !== undefined &&
      preview.settlementCurrency !== currency ? (
        <div className="mt-2 flex items-baseline justify-between gap-3 border-t pt-2 text-xs text-muted-foreground">
          <span>结算金额（{preview.settlementCurrency}）</span>
          <span className="tabular-nums">
            {money(preview.settlementTotal, preview.settlementCurrency)}
            {preview.fxRate ? ` · 汇率 ${(preview.fxRate / 1_000_000).toFixed(6)}` : ''}
          </span>
        </div>
      ) : null}
      {preview.summary ? (
        <p className="mt-1 text-xs text-muted-foreground">{preview.summary}</p>
      ) : null}
      {preview.breakdown && preview.breakdown.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t pt-2 text-xs text-muted-foreground">
          {preview.breakdown.map((item, index) => (
            <li key={index} className="flex justify-between gap-3">
              <span>
                {item.label}：{item.value}
              </span>
              {item.price != null ? <span>{money(item.price, currency)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const ProductDetailPage: FrontendPageComponent = (props) => {
  const product = props.data.product as StoreProduct | undefined;
  const methods = props.data.methods as z.infer<typeof paymentMethodsSchema> | undefined;
  if (!product) return <ProductNotFound />;
  const walletPurchase = props.actions['store.create-order-wallet'];
  const externalPurchase = props.actions['store.create-order-external'];
  const addToCart = props.actions['store.add-to-cart'];
  const viewer = props.data.viewer as { authenticated: boolean } | undefined;
  const isAuthed = Boolean(viewer?.authenticated);
  const metadata = product.metadata ?? {};
  const specs =
    metadata && typeof metadata.specs === 'object' && metadata.specs !== null
      ? (metadata.specs as Record<string, unknown>)
      : null;
  const checkoutConfig = readCheckoutConfig(metadata);
  const pricePreview = props.data.pricePreview as
    (PricePreview & { selection?: Selection }) | undefined;
  const currentSelection = pricePreview?.selection ?? defaultSelection(checkoutConfig);
  const configJson = currentSelection ? JSON.stringify(currentSelection) : '';
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6 sm:py-16 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/shop"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="rotate-180">
            <Icon name="arrow" />
          </span>
          返回服务目录
        </Link>
        <Link
          href="/shop/cart"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Icon name="cart" />
          购物车
        </Link>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm">
          <div className="relative flex h-40 items-center justify-center bg-muted/40">
            <div
              className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(24rem_10rem_at_50%_120%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
              aria-hidden="true"
            />
            <span className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <span className="text-2xl">
                <Icon name="package" />
              </span>
            </span>
          </div>
          <div className="p-6 sm:p-8">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-primary">服务</p>
              <div className="flex items-center gap-2">
                {product.fulfillmentType ? (
                  <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    {fulfillmentLabel(product.fulfillmentType)}
                  </span>
                ) : null}
                <StockBadge stock={product.stock} />
              </div>
            </div>
            <h1 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              {product.name}
            </h1>
            {product.description ? (
              <p className="mt-5 max-w-2xl text-sm leading-7 text-muted-foreground">
                {product.description}
              </p>
            ) : null}
            {specs ? (
              <dl className="mt-8 grid gap-x-8 gap-y-4 border-t pt-6 text-sm sm:grid-cols-2">
                {Object.entries(specs).map(([key, value]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-4 rounded-lg bg-muted/40 px-3.5 py-2.5"
                  >
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="text-right font-medium">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {checkoutConfig ? (
              <CheckoutConfigForm
                product={product}
                config={checkoutConfig}
                selection={currentSelection}
              />
            ) : null}
          </div>
        </section>

        <aside className="h-fit rounded-2xl border bg-card p-6 text-card-foreground shadow-sm lg:sticky lg:top-20">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            价格
          </p>
          <div className="mt-2 flex flex-wrap items-baseline gap-2 text-3xl">
            <PriceTag amount={pricePreview?.total ?? product.price} currency={product.currency} />
            {pricePreview ? null : (
              <>
                {product.originalPrice != null && product.originalPrice > product.price ? (
                  <span className="text-base text-muted-foreground/60 line-through">
                    {money(product.originalPrice, product.currency)}
                  </span>
                ) : null}
                {product.discount != null && product.discount > 0 ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {product.discount}% 折扣
                  </span>
                ) : null}
              </>
            )}
          </div>
          {checkoutConfig && !pricePreview ? (
            <p className="mt-2 text-xs text-muted-foreground">配置价格将在选择后计算。</p>
          ) : null}
          {pricePreview ? (
            <CheckoutPricePreview preview={pricePreview} currency={product.currency} />
          ) : null}
          <p className="mt-4 text-sm text-muted-foreground">
            {product.stock > 0 ? `库存 ${product.stock} 件` : '暂时缺货，请稍后再来'}
          </p>
          {product.stock > 0 ? (
            <div className="mt-6 space-y-3 border-t pt-5">
              {addToCart ? (
                isAuthed ? (
                  <form action={addToCart}>
                    <input type="hidden" name="productId" value={product.id} />
                    {configJson ? <input type="hidden" name="config" value={configJson} /> : null}
                    <Quantity />
                    <button
                      type="submit"
                      className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border bg-background px-4 text-sm font-semibold transition-colors hover:bg-muted"
                    >
                      <Icon name="cart" />
                      加入购物车
                    </button>
                  </form>
                ) : (
                  <Link
                    href={`/login?next=${encodeURIComponent(`/shop/${product.id}`)}`}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border bg-background px-4 text-sm font-semibold transition-colors hover:bg-muted"
                  >
                    <Icon name="cart" />
                    登录后加入购物车
                  </Link>
                )
              ) : null}
              {walletPurchase ? (
                <form action={walletPurchase}>
                  <input type="hidden" name="productId" value={product.id} />
                  {configJson ? <input type="hidden" name="config" value={configJson} /> : null}
                  <Quantity />
                  <button
                    type="submit"
                    className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-foreground px-4 text-sm font-semibold text-background shadow-sm transition-opacity hover:opacity-90"
                  >
                    <Icon name="wallet" />
                    余额支付
                  </button>
                </form>
              ) : null}
              {externalPurchase
                ? methods?.providers.flatMap((provider) =>
                    provider.methods.map((method) => (
                      <form key={`${provider.id}-${method.id}`} action={externalPurchase}>
                        <input type="hidden" name="productId" value={product.id} />
                        <input type="hidden" name="providerId" value={provider.id} />
                        <input type="hidden" name="paymentMethod" value={method.id} />
                        {configJson ? (
                          <input type="hidden" name="config" value={configJson} />
                        ) : null}
                        <Quantity />
                        <button
                          type="submit"
                          className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border bg-background px-4 text-sm font-semibold transition-colors hover:bg-muted"
                        >
                          {method.label}
                        </button>
                      </form>
                    )),
                  )
                : null}
            </div>
          ) : null}
        </aside>
      </div>
    </main>
  );
};

function StoreCartPage(props: Parameters<FrontendPageComponent>[0]): ReactElement {
  const cart = props.data.cart as CartPayload | undefined;
  const updateQty = props.actions['store.update-cart-item'];
  const removeItem = props.actions['store.remove-cart-item'];
  const checkoutWallet = props.actions['store.checkout-wallet'];
  const checkoutExternal = props.actions['store.checkout-external'];
  const methods = props.data.methods as z.infer<typeof paymentMethodsSchema> | undefined;
  const items = (cart?.items ?? []).filter((item) => item.product.status === 'ACTIVE');
  const hasProviders = Boolean(methods?.providers.length);
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6 sm:py-16 lg:px-8">
      <Link
        href="/shop"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="rotate-180">
          <Icon name="arrow" />
        </span>
        返回服务目录
      </Link>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">购物车</h1>
        </div>
      </div>
      {items.length ? (
        <div className="mt-8 space-y-8">
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {items.map((item) => (
              <li
                key={item.id}
                className="grid gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_7rem_8rem_auto] sm:items-center sm:px-6"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon name="package" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{item.product.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {money(item.product.price, item.product.currency)} / 件
                      </p>
                      {item.summary ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">{item.summary}</p>
                      ) : null}
                    </div>
                  </div>
                </div>
                {updateQty ? (
                  <div className="flex items-center gap-2">
                    <form action={updateQty} className="flex items-center gap-2">
                      <input type="hidden" name="id" value={item.id} />
                      <input
                        name="quantity"
                        type="number"
                        min="1"
                        max={Math.min(item.product.stock, 100)}
                        defaultValue={item.quantity}
                        className="h-9 w-20 rounded-lg border bg-background px-2 text-center text-sm"
                      />
                      <button
                        type="submit"
                        className="inline-flex h-9 items-center gap-1 rounded-lg bg-muted px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/70"
                      >
                        更新
                      </button>
                    </form>
                  </div>
                ) : null}
                <span className="font-mono text-sm font-semibold tabular-nums">
                  {money(item.total, item.product.currency)}
                </span>
                <div className="flex items-start gap-3">
                  {removeItem ? (
                    <form action={removeItem}>
                      <input type="hidden" name="id" value={item.id} />
                      <button
                        type="submit"
                        className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        aria-label="移除"
                      >
                        <Icon name="trash" />
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          <section className="rounded-2xl border bg-card p-6 shadow-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">合计</span>
              <div className="text-2xl">
                <PriceTag amount={cart?.total ?? 0} currency={cart?.items[0]?.product.currency ?? 'CNY'} />
              </div>
            </div>
            <div className="mt-6 space-y-3 border-t pt-5">
              <p className="text-sm font-semibold">选择要结算的商品</p>
              {checkoutWallet ? (
                <form action={checkoutWallet} className="space-y-3">
                  <ul className="divide-y rounded-xl border bg-background">
                    {items.map((item) => (
                      <li key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                        <input
                          type="checkbox"
                          name="cartItemIds"
                          value={item.id}
                          defaultChecked
                          className="size-4 accent-primary"
                        />
                        <span className="min-w-0 flex-1 truncate">{item.product.name}</span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {money(item.total, item.product.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="submit"
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-foreground px-4 text-sm font-semibold text-background shadow-sm transition-opacity hover:opacity-90"
                  >
                    <Icon name="wallet" />
                    余额支付结算
                  </button>
                </form>
              ) : null}
              {checkoutExternal && hasProviders
                ? methods.providers.flatMap((provider) =>
                    provider.methods.map((method) => (
                      <form
                        key={`${provider.id}-${method.id}`}
                        action={checkoutExternal}
                        className="space-y-3"
                      >
                        <ul className="divide-y rounded-xl border bg-background">
                          {items.map((item) => (
                            <li
                              key={item.id}
                              className="flex items-center gap-3 px-4 py-2.5 text-sm"
                            >
                              <input
                                type="checkbox"
                                name="cartItemIds"
                                value={item.id}
                                defaultChecked
                                className="size-4 accent-primary"
                              />
                              <span className="min-w-0 flex-1 truncate">{item.product.name}</span>
                              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                {money(item.total, item.product.currency)}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <input type="hidden" name="providerId" value={provider.id} />
                        <input type="hidden" name="paymentMethod" value={method.id} />
                        <button
                          type="submit"
                          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border bg-background px-4 text-sm font-semibold transition-colors hover:bg-muted"
                        >
                          {method.label} 结算
                        </button>
                      </form>
                    )),
                  )
                : null}
            </div>
          </section>
        </div>
      ) : (
        <div className="mt-10">
          <Empty text="购物车是空的，去挑几件服务吧。" />
        </div>
      )}
    </main>
  );
}

function Quantity(): ReactElement {
  return (
    <label className="block text-xs text-muted-foreground">
      数量
      <input
        name="quantity"
        type="number"
        min="1"
        max="100"
        defaultValue="1"
        className="mt-1 h-10 w-full rounded-lg border bg-background px-3 text-sm"
      />
    </label>
  );
}
function ProductNotFound(): ReactElement {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <p className="bg-linear-to-r from-primary to-primary/40 bg-clip-text font-mono text-5xl font-bold text-transparent">
        404
      </p>
      <p className="mt-4 text-sm text-muted-foreground">服务不存在或已下架。</p>
      <Link
        href="/shop"
        className="mt-8 inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-5 text-sm font-semibold text-background shadow-sm transition-opacity hover:opacity-90"
      >
        返回服务目录
        <Icon name="arrow" />
      </Link>
    </main>
  );
}
function Empty({ text }: { text: string }): ReactElement {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Icon name="package" />
      </span>
      <p className="mt-4 text-sm font-medium">{text}</p>
    </div>
  );
}

function StoreAccountOrdersPage(props: AccountPageComponentProps): ReactElement {
  const orders = (props.data.orders as StoreOrder[] | undefined) ?? [];
  const cancel = props.actions?.['store.cancel-order'];
  return (
    <main>
      <PageHeader title="历史订单" />
      {orders.length ? (
        <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
          {orders.map((order) => (
            <li
              key={order.id}
              className="grid gap-3 px-5 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto] sm:items-center sm:px-6"
            >
              <span className="truncate font-mono text-xs text-muted-foreground">{order.id}</span>
              <span className="flex flex-col gap-0.5">
                <span className="font-mono font-semibold">{money(order.total, order.currency)}</span>
                {order.settlementCurrency &&
                order.settlementTotal !== undefined &&
                order.settlementCurrency !== order.currency ? (
                  <span className="text-xs text-muted-foreground">
                    结算 {money(order.settlementTotal, order.settlementCurrency)}
                  </span>
                ) : null}
              </span>
              <OrderStatus status={order.status} />
              <span className="flex items-center gap-3">
                {order.payment?.paymentUrl && order.status === 'PENDING' ? (
                  <a href={order.payment.paymentUrl} className="text-primary hover:underline">
                    继续付款
                  </a>
                ) : null}
                {cancel && order.status === 'PENDING' ? (
                  <form action={cancel}>
                    <input type="hidden" name="id" value={order.id} />
                    <button type="submit" className="text-muted-foreground hover:text-destructive">
                      取消
                    </button>
                  </form>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty text="还没有订单" />
      )}
    </main>
  );
}

function ServiceStatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string | null;
}): ReactElement {
  const tone =
    status === 'ACTIVE'
      ? 'bg-success/10 text-success'
      : status === 'PROVISIONING' || status === 'PENDING_PROVISION'
        ? 'bg-warning/10 text-warning'
        : status === 'FAILED' || status === 'TERMINATED'
          ? 'bg-destructive/10 text-destructive'
          : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label ?? SERVICE_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** 服务状态的中文展示名（无上游标签时的回退）。 */
const SERVICE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: '运行中',
  PENDING_PROVISION: '待开通',
  PROVISIONING: '开通中',
  SUSPENDED: '已暂停',
  TERMINATED: '已终止',
  FAILED: '失败',
};

function MetricsChart({
  series,
}: {
  series: Array<{
    id: string;
    label: string;
    unit: string;
    color?: string;
    points: Array<{ t: number; v: number }>;
  }>;
}): ReactElement {
  if (!series.length) return <p className="text-sm text-muted-foreground">暂无监控数据</p>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {series.map((item) => {
        const pts = item.points;
        const color = item.color ?? 'var(--primary)';
        if (!pts.length) {
          return (
            <div key={item.id} className="rounded-xl border bg-card p-4">
              <p className="text-sm font-semibold">{item.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">暂无数据</p>
            </div>
          );
        }
        const min = Math.min(...pts.map((p) => p.v));
        const max = Math.max(...pts.map((p) => p.v));
        const span = max - min || 1;
        const w = 320;
        const h = 96;
        const poly = pts
          .map((p, i) => {
            const x = (i / (pts.length - 1)) * w;
            const y = h - ((p.v - min) / span) * (h - 8) - 4;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ');
        const latest = pts[pts.length - 1]?.v;
        return (
          <div key={item.id} className="rounded-xl border bg-card p-4">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-semibold">{item.label}</p>
              <p className="font-mono text-sm">
                {latest?.toFixed(1)}
                <span className="ml-0.5 text-xs text-muted-foreground">{item.unit}</span>
              </p>
            </div>
            <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 w-full" aria-hidden="true">
              <polyline points={poly} fill="none" stroke={color} strokeWidth="2" />
            </svg>
          </div>
        );
      })}
    </div>
  );
}

function StoreAccountServicesPage(props: AccountPageComponentProps): ReactElement {
  const services =
    (props.data.services as Array<z.infer<typeof serviceSummarySchema>> | undefined) ?? [];
  return (
    <main>
      <PageHeader title="我的云服务" />
      {services.length ? (
        <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
          {services.map((service) => (
            <li key={service.id}>
              <a
                href={`/account/services/${service.id}`}
                className="grid gap-3 px-5 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-center sm:px-6"
              >
                <span className="truncate font-semibold">{service.productName}</span>
                <span className="font-mono text-muted-foreground">
                  {money(service.amount, service.currency)}
                </span>
                <ServiceStatusBadge status={service.status} />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <Empty text="还没有服务，去选购吧" />
      )}
    </main>
  );
}

function StoreAccountServiceDetailPage(props: AccountPageComponentProps): ReactElement {
  const service = props.data.service as z.infer<typeof serviceSchema>['service'] | undefined;
  const metrics =
    (props.data.metrics as
      | Array<{
          id: string;
          label: string;
          unit: string;
          color?: string;
          points: Array<{ t: number; v: number }>;
        }>
      | undefined) ?? [];
  const runAction = props.actions?.['store.service-action'];
  const renewAction = props.actions?.['store.renew-service-wallet'];
  const resourceCreateAction = props.actions?.['store.service-resource-create'];
  const resourceRunAction = props.actions?.['store.service-resource-action'];
  const changeAction = props.actions?.['store.service-change-wallet'];
  const resourceGroups =
    (props.data.resources as
      | Array<{
          kind: z.infer<typeof resourceKindSchema>;
          resources: Array<z.infer<typeof resourceListSchema>['resources'][number]>;
        }>
      | undefined) ?? [];
  const changeOptions = props.data.changeOptions as
    | {
        productId: string;
        productName: string;
        config: CheckoutConfig | null;
        current: Selection | null;
      }
    | null
    | undefined;
  const changeQuote = props.data.changeQuote as
    { diff: number; currency: string; summary?: string; selection: Selection } | null | undefined;
  if (!service) return <Empty text="服务不存在" />;
  const fields = service.detail?.fields ?? [];
  const actions = service.detail?.actions ?? [];
  const renewable = service.status === 'ACTIVE' || service.status === 'SUSPENDED';
  return (
    <main className="space-y-6">
      <PageHeader title={service.detail?.title ?? service.productName} />
      <div className="flex items-center gap-3">
        <ServiceStatusBadge
          status={service.detail?.status ?? service.status}
          label={service.detail?.statusLabel}
        />
        <span className="font-mono text-xs text-muted-foreground">{service.id}</span>
        {service.expiresAt ? (
          <span className="text-xs text-muted-foreground">
            到期：{service.expiresAt.slice(0, 10)}
          </span>
        ) : null}
      </div>

      {fields.length ? (
        <dl className="grid gap-px overflow-hidden rounded-2xl border bg-border/60 sm:grid-cols-2">
          {fields.map((field) => (
            <div key={field.label} className="bg-card p-4">
              <dt className="text-xs text-muted-foreground">{field.label}</dt>
              <dd className="mt-1 break-all font-mono text-sm">
                {field.secret ? (
                  '••••••••'
                ) : isHttpUrl(field.value) ? (
                  <a
                    href={field.value}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    {field.value}
                  </a>
                ) : (
                  field.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {actions.length && runAction ? (
        <div className="flex flex-wrap gap-3">
          {actions.map((action) => {
            const extraParams = (action.params ?? []).filter(
              (param) => !STATIC_ACTION_FIELDS.has(param.name),
            );
            return (
              <form
                key={action.id}
                action={runAction}
                className="flex flex-wrap items-end gap-3 rounded-2xl border bg-card p-4"
              >
                <input type="hidden" name="id" value={service.id} />
                <input type="hidden" name="actionId" value={action.id} />
                {(action.params ?? [])
                  .filter((param) => STATIC_ACTION_FIELDS.has(param.name))
                  .map((param) => (
                    <div key={param.name} className="flex flex-col gap-1">
                      <label
                        htmlFor={`action-${action.id}-${param.name}`}
                        className="text-xs text-muted-foreground"
                      >
                        {param.label}
                        {param.required ? ' *' : ''}
                      </label>
                      {param.type === 'select' ? (
                        <select
                          id={`action-${action.id}-${param.name}`}
                          name={param.name}
                          required={param.required}
                          defaultValue={param.default != null ? String(param.default) : ''}
                          className="h-10 rounded-xl border bg-background px-3 text-sm"
                        >
                          <option value="">请选择</option>
                          {(param.options ?? []).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : param.type === 'textarea' ? (
                        <textarea
                          id={`action-${action.id}-${param.name}`}
                          name={param.name}
                          required={param.required}
                          defaultValue={param.default != null ? String(param.default) : ''}
                          maxLength={param.maxLength}
                          placeholder={param.placeholder}
                          rows={3}
                          className="rounded-xl border bg-background px-3 py-2 text-sm"
                        />
                      ) : (
                        <input
                          id={`action-${action.id}-${param.name}`}
                          name={param.name}
                          type={
                            param.type === 'password'
                              ? 'password'
                              : param.type === 'number'
                                ? 'number'
                                : 'text'
                          }
                          required={param.required}
                          defaultValue={param.default != null ? String(param.default) : ''}
                          min={param.min}
                          max={param.max}
                          maxLength={param.maxLength}
                          placeholder={param.placeholder}
                          className="h-10 rounded-xl border bg-background px-3 text-sm"
                        />
                      )}
                    </div>
                  ))}
                {extraParams.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor={`action-${action.id}-params`}
                      className="text-xs text-muted-foreground"
                    >
                      附加参数（JSON）
                    </label>
                    <textarea
                      id={`action-${action.id}-params`}
                      name="params"
                      rows={2}
                      maxLength={4000}
                      placeholder={`{"${extraParams[0]!.name}": "…"}`}
                      className="rounded-xl border bg-background px-3 py-2 font-mono text-sm"
                    />
                    <span className="text-[11px] text-muted-foreground">
                      可用键：{extraParams.map((param) => param.name).join('、')}
                    </span>
                  </div>
                ) : null}
                <button
                  type="submit"
                  className={
                    action.danger
                      ? 'h-10 rounded-xl border border-destructive/40 px-4 text-sm font-semibold text-destructive hover:bg-destructive/10'
                      : 'h-10 rounded-xl bg-foreground px-4 text-sm font-semibold text-background'
                  }
                >
                  {action.label}
                </button>
              </form>
            );
          })}
        </div>
      ) : null}

      {renewable && renewAction ? (
        <form
          action={renewAction}
          className="flex flex-wrap items-end gap-3 rounded-2xl border bg-card p-4"
        >
          <input type="hidden" name="id" value={service.id} />
          <input type="hidden" name="paymentMode" value="wallet" />
          <div>
            <label htmlFor="renew-months" className="mb-1 block text-xs text-muted-foreground">
              续费时长（月）
            </label>
            <input
              id="renew-months"
              name="months"
              type="number"
              min={1}
              max={120}
              defaultValue={1}
              className="h-10 w-28 rounded-xl border bg-background px-3 text-sm"
            />
          </div>
          <button
            type="submit"
            className="h-10 rounded-xl bg-foreground px-4 text-sm font-semibold text-background"
          >
            续费（余额支付）
          </button>
        </form>
      ) : null}

      {changeAction && changeOptions?.config ? (
        <ServiceChangePanel
          serviceId={service.id}
          currency={service.currency}
          config={changeOptions.config}
          current={changeOptions.current}
          quote={changeQuote ?? null}
          changeAction={changeAction}
        />
      ) : null}

      {resourceGroups.length ? (
        <ServiceResourcesPanel
          serviceId={service.id}
          groups={resourceGroups}
          createAction={resourceCreateAction}
          runAction={resourceRunAction}
        />
      ) : null}

      <div>
        <SectionTitle className="mb-3">监控</SectionTitle>
        <MetricsChart series={metrics} />
      </div>
    </main>
  );
}

/** 升配/降配面板：GET 试算差价 → POST 下变配订单。 */
function ServiceChangePanel({
  serviceId,
  currency,
  config,
  current,
  quote,
  changeAction,
}: {
  serviceId: string;
  currency: string;
  config: CheckoutConfig;
  current: Selection | null;
  quote: { diff: number; currency: string; summary?: string; selection: Selection } | null;
  changeAction: string;
}): ReactElement {
  const sel = current?.selections ?? {};
  const cycle = current?.cycle ?? config.cycles[0]?.id ?? '';
  const groups: Array<{ name: string; options: CheckoutOption[] }> = [];
  for (const option of config.options) {
    if (!optionVisible(option, sel, cycle)) continue;
    const name = option.group ?? '';
    const bucket = groups.find((candidate) => candidate.name === name);
    if (bucket) bucket.options.push(option);
    else groups.push({ name, options: [option] });
  }
  return (
    <section className="space-y-3 rounded-2xl border bg-card p-4">
      <SectionTitle>升配 / 降配</SectionTitle>
      <form method="get" action={`/account/services/${serviceId}`} className="space-y-4">
        <div className="grid gap-1.5">
          <label className="text-sm font-medium">计费周期</label>
          <select
            name="cycle"
            defaultValue={cycle}
            className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
          >
            {config.cycles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        {groups.map((group) => (
          <fieldset key={group.name || 'default'} className="space-y-4 rounded-xl border p-3">
            {group.name ? (
              <legend className="px-1 text-xs font-semibold text-muted-foreground">
                {group.name}
              </legend>
            ) : null}
            {group.options.map((option) => {
              const value = sel[option.id];
              const choices = allowedChoices(option, sel, cycle);
              if (option.type === 'quantity') {
                return (
                  <div key={option.id} className="grid gap-1.5">
                    <label className="text-sm font-medium">{option.label}</label>
                    <input
                      name={`cfg_${option.id}`}
                      type="number"
                      min={option.min ?? 0}
                      max={option.max ?? undefined}
                      step={option.step ?? 1}
                      defaultValue={typeof value === 'number' ? value : (option.min ?? 0)}
                      className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
                    />
                  </div>
                );
              }
              return (
                <div key={option.id} className="grid gap-1.5">
                  <label className="text-sm font-medium">{option.label}</label>
                  <select
                    name={`cfg_${option.id}`}
                    defaultValue={typeof value === 'string' ? value : (choices[0]?.id ?? '')}
                    className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
                  >
                    {choices.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </fieldset>
        ))}
        <button
          type="submit"
          className="h-10 rounded-xl border bg-background px-4 text-sm font-semibold hover:bg-muted"
        >
          试算差价
        </button>
      </form>
      {quote ? (
        <form action={changeAction} className="flex items-center gap-3 border-t pt-3">
          <input type="hidden" name="id" value={serviceId} />
          <input type="hidden" name="paymentMode" value="wallet" />
          <input type="hidden" name="config" value={JSON.stringify(quote.selection)} />
          <span className="text-sm">
            需补差价：
            <span className="font-semibold">{money(quote.diff, quote.currency || currency)}</span>
            {quote.summary ? (
              <span className="ml-2 text-xs text-muted-foreground">{quote.summary}</span>
            ) : null}
          </span>
          <button
            type="submit"
            className="h-10 rounded-xl bg-foreground px-4 text-sm font-semibold text-background"
          >
            确认变更（余额支付）
          </button>
        </form>
      ) : null}
    </section>
  );
}

/** 增值运维面板：按资源种类渲染列表 + 新建 + 行内动作。 */
function ServiceResourcesPanel({
  serviceId,
  groups,
  createAction,
  runAction,
}: {
  serviceId: string;
  groups: Array<{
    kind: z.infer<typeof resourceKindSchema>;
    resources: Array<z.infer<typeof resourceListSchema>['resources'][number]>;
  }>;
  createAction?: string;
  runAction?: string;
}): ReactElement {
  return (
    <section className="space-y-4">
      <SectionTitle>资源管理</SectionTitle>
      {groups.map(({ kind, resources }) => (
        <div key={kind.id} className="space-y-3 rounded-2xl border bg-card p-4">
          <h3 className="text-sm font-semibold">{kind.label}</h3>
          {resources.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  {(kind.columns ?? []).map((column) => (
                    <th key={column.key} className="py-1">
                      {column.label}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {resources.map((resource) => (
                  <tr key={resource.id} className="border-t">
                    {(kind.columns ?? []).map((column) => (
                      <td key={column.key} className="py-1.5">
                        {resource.fields[column.key] ?? ''}
                      </td>
                    ))}
                    <td className="py-1.5">
                      <div className="flex flex-wrap gap-2">
                        {(kind.rowActions ?? []).map((rowAction) =>
                          runAction ? (
                            <form key={rowAction.id} action={runAction}>
                              <input type="hidden" name="id" value={serviceId} />
                              <input type="hidden" name="kind" value={kind.id} />
                              <input type="hidden" name="resourceId" value={resource.id} />
                              <input type="hidden" name="actionId" value={rowAction.id} />
                              {(rowAction.params ?? []).length ? (
                                <input
                                  type="text"
                                  name="params"
                                  defaultValue="{}"
                                  className="h-8 w-28 rounded-lg border bg-background px-2 font-mono text-xs"
                                />
                              ) : null}
                              <button
                                type="submit"
                                className={
                                  rowAction.danger
                                    ? 'rounded-lg border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10'
                                    : 'rounded-lg border px-2.5 py-1 text-xs font-medium hover:bg-muted'
                                }
                              >
                                {rowAction.label}
                              </button>
                            </form>
                          ) : null,
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-muted-foreground">暂无数据</p>
          )}
          {kind.creatable && createAction ? (
            <form action={createAction} className="flex flex-wrap items-end gap-2 border-t pt-3">
              <input type="hidden" name="id" value={serviceId} />
              <input type="hidden" name="kind" value={kind.id} />
              <div className="flex flex-1 flex-col gap-1">
                <label className="text-[11px] text-muted-foreground">
                  新建参数（JSON）
                  {(kind.createParams ?? []).length
                    ? ` · 可用键：${(kind.createParams ?? []).map((p) => p.name).join('、')}`
                    : ''}
                </label>
                <input
                  name="params"
                  defaultValue={JSON.stringify(
                    Object.fromEntries((kind.createParams ?? []).map((p) => [p.name, ''])),
                  )}
                  className="h-9 w-full rounded-lg border bg-background px-3 font-mono text-xs"
                />
              </div>
              <button
                type="submit"
                className="h-9 rounded-lg bg-foreground px-3 text-xs font-semibold text-background"
              >
                新建{kind.label}
              </button>
            </form>
          ) : null}
        </div>
      ))}
    </section>
  );
}

/** 平台 `store.service-action` 静态声明的字段名（其余动作参数走 `params` JSON 袋）。 */
const STATIC_ACTION_FIELDS = new Set(['os', 'password']);

/** 判断字段值是否为可点击的 http(s) 链接（如控制台地址）。 */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function OrderStatus({ status }: { status: string }): ReactElement {
  const tone =
    status === 'PENDING'
      ? 'bg-warning/10 text-warning'
      : status === 'COMPLETED' || status === 'PAID'
        ? 'bg-success/10 text-success'
        : status === 'CANCELLED' || status === 'FAILED'
          ? 'bg-destructive/10 text-destructive'
          : status === 'REFUNDED'
            ? 'bg-warning/10 text-warning'
            : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function StoreSummaryWidget(_props: AdminWidgetProps): ReactElement {
  return (
    <Link
      href="/admin/plugin/store/overview"
      className="backend-widget group flex min-h-24 items-center gap-3 p-4 text-card-foreground transition-colors hover:border-primary/40"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <PackageOpen className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">产品管理</span>
        <span className="mt-1 block text-xs text-muted-foreground">管理云产品与套餐</span>
      </span>
      <ArrowUpRight className="size-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
    </Link>
  );
}

const storeFinders: Record<string, FinderProvider> = {
  'store.products': {
    handler: async (input, ctx) =>
      (
        await ctx.api.get(
          `/products?page=${typeof input.page === 'number' ? input.page : 1}&pageSize=${typeof input.pageSize === 'number' ? input.pageSize : 20}`,
          publicProductListSchema,
        )
      ).products,
  },
  'store.product': {
    handler: async (input, ctx) =>
      (
        await ctx.api.get(
          `/products/${encodeURIComponent(typeof input.id === 'string' ? input.id : '')}`,
          publicProductSchema,
        )
      ).product,
  },
  // 账户商城：可购买目录与详情（需登录 + store.view）。服务端给出 purchasable。
  'store.accountProducts': {
    handler: async (input, ctx) =>
      (
        await ctx.api.get(
          `/store/account/products?page=${typeof input.page === 'number' ? input.page : 1}&pageSize=${typeof input.pageSize === 'number' ? input.pageSize : 20}`,
          purchasableProductListSchema,
        )
      ).products,
  },
  'store.accountProduct': {
    handler: async (input, ctx) =>
      (
        await ctx.api.get(
          `/store/account/products/${encodeURIComponent(typeof input.id === 'string' ? input.id : '')}`,
          purchasableProductSchema,
        )
      ).product,
  },
  'store.paymentMethods': {
    handler: async (_input, ctx) => ctx.api.get('/payment-methods', paymentMethodsSchema),
  },
  'store.pricePreview': {
    handler: async (input, ctx) => {
      const id = typeof input.id === 'string' ? input.id : '';
      if (!id) return null;
      const query = (input['$query'] ?? {}) as Record<string, string | string[] | undefined>;
      const selection = selectionFromQuery(query);
      if (!selection) return null;
      const body: Record<string, string> = {
        config: JSON.stringify(selection),
        quantity: String(typeof input.quantity === 'number' ? input.quantity : 1),
      };
      const price = await ctx.api.post(
        `/store/products/${encodeURIComponent(id)}/price`,
        body,
        pricePreviewSchema,
      );
      return { ...price, selection };
    },
  },
  'store.pendingOrderCount': {
    handler: async (_input, ctx) => {
      const schema = orderListSchema.extend({ total: z.number() });
      let count = 0;
      let page = 1;
      let fetched = 0;
      while (true) {
        const result = await ctx.api.get(`/orders?page=${page}&pageSize=100`, schema);
        count += result.orders.filter((order) => order.status === 'PENDING').length;
        fetched += result.orders.length;
        if (fetched >= result.total || result.orders.length === 0) break;
        page += 1;
      }
      return { count };
    },
  },
  'store.myOrders': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/orders?page=1&pageSize=50', orderListSchema)).orders,
  },
  'store.myServices': {
    handler: async (_input, ctx) => (await ctx.api.get('/services', serviceListSchema)).services,
  },
  'store.myService': {
    handler: async (input, ctx) =>
      (
        await ctx.api.get(
          `/services/${encodeURIComponent(typeof input.id === 'string' ? input.id : '')}`,
          serviceSchema,
        )
      ).service,
  },
  'store.myServiceMetrics': {
    handler: async (input, ctx) =>
      (
        await ctx.api.get(
          `/services/${encodeURIComponent(typeof input.id === 'string' ? input.id : '')}/metrics`,
          serviceMetricsSchema,
        )
      ).metrics,
  },
  'store.myServiceResources': {
    handler: async (input, ctx) => {
      const id = encodeURIComponent(typeof input.id === 'string' ? input.id : '');
      if (!id) return [];
      const { kinds } = await ctx.api.get(`/services/${id}/resource-kinds`, resourceKindsSchema);
      const result: Array<{
        kind: z.infer<typeof resourceKindSchema>;
        resources: Array<z.infer<typeof resourceListSchema>['resources'][number]>;
      }> = [];
      for (const kind of kinds) {
        const { resources } = await ctx.api.get(
          `/services/${id}/resources/${encodeURIComponent(kind.id)}`,
          resourceListSchema,
        );
        result.push({ kind, resources });
      }
      return result;
    },
  },
  'store.myServiceChangeOptions': {
    handler: async (input, ctx) => {
      const id = encodeURIComponent(typeof input.id === 'string' ? input.id : '');
      if (!id) return null;
      const { service } = await ctx.api.get(`/services/${id}`, serviceSchema);
      if (!service.productId) return null;
      const { product } = await ctx.api.get(
        `/products/${encodeURIComponent(service.productId)}`,
        publicProductSchema,
      );
      const config = readCheckoutConfig(product.metadata);
      const runtime = (service.runtime ?? {}) as Record<string, unknown>;
      const current = runtime['config'] as Selection | undefined;
      return {
        productId: service.productId,
        productName: product.name,
        config,
        current: current ?? null,
      };
    },
  },
  'store.myServiceChangeQuote': {
    handler: async (input, ctx) => {
      const id = encodeURIComponent(typeof input.id === 'string' ? input.id : '');
      if (!id) return null;
      const query = (input['$query'] ?? {}) as Record<string, string | string[] | undefined>;
      const selection = selectionFromQuery(query);
      if (!selection) return null;
      const quote = await ctx.api.post(
        `/services/${id}/change-quote`,
        { config: JSON.stringify(selection) },
        changeQuoteSchema,
      );
      return { ...quote, selection };
    },
  },
  'store.adminSummary': {
    handler: async (_input, ctx) =>
      ctx.api.get(
        '/store/admin/products?page=1&pageSize=5',
        productListSchema.extend({ total: z.number() }),
      ),
  },
  'store.adminProducts': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/store/admin/products?page=1&pageSize=50', productListSchema)).products,
  },
  'store.adminProduct': {
    handler: async (input, ctx) => {
      const schema = productListSchema.extend({ total: z.number() });
      // 管理列表包含完整 metadata 与未上架商品；不使用公开商品接口。
      for (let page = 1; ; page += 1) {
        const result = await ctx.api.get(`/store/admin/products?page=${page}&pageSize=100`, schema);
        const product = result.products.find((item) => item.id === input.id);
        if (product) return product;
        if (result.products.length === 0 || page * 100 >= result.total) return null;
      }
    },
  },
  'store.adminProductCategoryIds': {
    handler: async (input, ctx) => {
      const schema = z.object({
        products: z.array(
          z.object({
            product: z.object({ id: z.string() }),
            catalog: z.object({ categoryIds: z.array(z.string()) }).nullable(),
          }),
        ),
        total: z.number(),
      });
      for (let page = 1; ; page += 1) {
        const result = await ctx.api.get(
          `/catalog/admin/products?page=${page}&pageSize=100`,
          schema,
        );
        const entry = result.products.find((item) => item.product.id === input.id);
        if (entry) return entry.catalog?.categoryIds ?? [];
        if (result.products.length === 0 || page * 100 >= result.total) return [];
      }
    },
  },
  'store.productTypes': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/store/product-types', productTypeListSchema)).types,
  },
  /** Enabled currencies from the kernel catalog (admin product editor picker). */
  'store.currencies': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/currency-definitions', currencyDefinitionListSchema)).currencies,
  },
  'store.upstreamSources': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/store/upstream-sources', upstreamSourceListSchema)).sources,
  },
  'store.cart': {
    handler: async (_input, ctx) => ctx.api.get('/cart', cartSchema),
  },
  'store.viewer': {
    handler: async (_input, ctx) => ({ authenticated: Boolean(ctx.session) }),
  },
};

export const frontend: FrontendPackage = {
  settingsSchema,
  finders: storeFinders,
  pages: [
    {
      path: '/shop',
      component: 'shop',
      data: [
        { finder: 'store.products', as: 'products', input: { page: 1, pageSize: 60 } },
        { finder: 'catalog.categories', as: 'categories' },
        {
          finder: 'catalog.products',
          as: 'catalogProducts',
          input: { page: 1, pageSize: 60, categoryId: '', showAll: '', q: '' },
        },
      ],
    },
    {
      path: '/shop/:id',
      component: 'product',
      data: [
        { finder: 'store.product', as: 'product', input: { id: ':id' } },
        { finder: 'store.paymentMethods', as: 'methods' },
        { finder: 'store.viewer', as: 'viewer' },
        {
          finder: 'store.pricePreview',
          as: 'pricePreview',
          input: { id: ':id', $query: '1', quantity: '' },
        },
      ],
    },
    {
      path: '/shop/cart',
      component: 'cart',
      data: [
        { finder: 'store.cart', as: 'cart' },
        { finder: 'store.paymentMethods', as: 'methods' },
      ],
    },
  ],
  pageComponents: {
    shop: ProductListPage,
    product: ProductDetailPage,
    cart: StoreCartPage,
  },
  ui: {
    actions: [
      {
        id: 'store.create-order-wallet',
        method: 'POST',
        path: '/orders',
        permission: 'store.buy',
        input: [
          { name: 'productId', type: 'string', required: true, maxLength: 191 },
          { name: 'quantity', type: 'integer', default: 1, min: 1, max: 100 },
          { name: 'paymentMode', type: 'string', default: 'wallet' },
          { name: 'config', type: 'string', maxLength: 40000 },
        ],
        redirect: { responsePath: 'nextPath' },
      },
      {
        id: 'store.create-order-external',
        method: 'POST',
        path: '/orders',
        permission: 'store.buy',
        input: [
          { name: 'productId', type: 'string', required: true, maxLength: 191 },
          { name: 'quantity', type: 'integer', default: 1, min: 1, max: 100 },
          { name: 'paymentMode', type: 'string', default: 'external' },
          { name: 'providerId', type: 'string', required: true, maxLength: 64 },
          { name: 'paymentMethod', type: 'string', required: true, maxLength: 64 },
          { name: 'config', type: 'string', maxLength: 40000 },
        ],
        redirect: { responsePath: 'payment.paymentUrl', external: true },
      },
      {
        id: 'store.add-to-cart',
        method: 'POST',
        path: '/cart/items',
        permission: 'store.buy',
        input: [
          { name: 'productId', type: 'string', required: true, maxLength: 191 },
          { name: 'quantity', type: 'integer', default: 1, min: 1, max: 100 },
          { name: 'config', type: 'string', maxLength: 40000 },
        ],
        redirect: { responsePath: 'nextPath' },
      },
      {
        id: 'store.update-cart-item',
        method: 'PATCH',
        path: '/cart/items/:id',
        permission: 'store.buy',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'quantity', type: 'integer', required: true, min: 1, max: 100 },
        ],
      },
      {
        id: 'store.remove-cart-item',
        method: 'DELETE',
        path: '/cart/items/:id',
        permission: 'store.buy',
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
      {
        id: 'store.checkout-wallet',
        method: 'POST',
        path: '/cart/checkout',
        permission: 'store.buy',
        input: [
          { name: 'cartItemIds', type: 'ids', required: true, max: 50, maxLength: 191 },
          { name: 'paymentMode', type: 'string', default: 'wallet' },
        ],
        redirect: { responsePath: 'nextPath' },
      },
      {
        id: 'store.checkout-external',
        method: 'POST',
        path: '/cart/checkout',
        permission: 'store.buy',
        input: [
          { name: 'cartItemIds', type: 'ids', required: true, max: 50, maxLength: 191 },
          { name: 'paymentMode', type: 'string', default: 'external' },
          { name: 'providerId', type: 'string', required: true, maxLength: 64 },
          { name: 'paymentMethod', type: 'string', required: true, maxLength: 64 },
        ],
        redirect: { responsePath: 'payment.paymentUrl', external: true },
      },
      {
        id: 'store.cancel-order',
        method: 'POST',
        path: '/orders/:id/cancel',
        permission: 'store.buy',
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
      {
        id: 'store.service-action',
        method: 'POST',
        path: '/services/:id/actions',
        permission: 'store.view',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'actionId', type: 'string', required: true, maxLength: 64 },
          // 具体参数名由动作声明决定（如重装的 os、重置密码的 password）。
          { name: 'os', type: 'string', maxLength: 64 },
          { name: 'password', type: 'string', maxLength: 128 },
          // 通用参数袋（JSON 对象字符串）：动作声明了 os/password 之外的参数时使用。
          { name: 'params', type: 'string', maxLength: 4000 },
        ],
      },
      {
        id: 'store.renew-service-wallet',
        method: 'POST',
        path: '/services/:id/renew',
        permission: 'store.buy',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'paymentMode', type: 'string', default: 'wallet' },
          { name: 'months', type: 'integer', default: 1, min: 1, max: 120 },
        ],
        redirect: { responsePath: 'nextPath' },
      },
      {
        id: 'store.service-resource-create',
        method: 'POST',
        path: '/services/:id/resources/:kind',
        permission: 'store.buy',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'kind', type: 'string', required: true, maxLength: 64 },
          // 具体参数名由资源种类声明决定；通用参数袋承载动态键值。
          { name: 'params', type: 'string', maxLength: 4000 },
        ],
      },
      {
        id: 'store.service-resource-action',
        method: 'POST',
        path: '/services/:id/resources/:kind/:resourceId/actions/:actionId',
        permission: 'store.buy',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'kind', type: 'string', required: true, maxLength: 64 },
          { name: 'resourceId', type: 'string', required: true, maxLength: 191 },
          { name: 'actionId', type: 'string', required: true, maxLength: 64 },
          { name: 'params', type: 'string', maxLength: 4000 },
        ],
      },
      {
        id: 'store.service-change-wallet',
        method: 'POST',
        path: '/services/:id/change',
        permission: 'store.buy',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'paymentMode', type: 'string', default: 'wallet' },
          { name: 'config', type: 'string', maxLength: 40000 },
          { name: 'targetProductId', type: 'string', maxLength: 191 },
        ],
        redirect: { responsePath: 'nextPath' },
      },
      {
        id: 'store.admin-transfer-service',
        method: 'POST',
        path: '/store/admin/services/:id/transfer',
        permission: 'store.admin',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'targetUserId', type: 'string', required: true, maxLength: 191 },
        ],
      },
      {
        id: 'store.admin-refund-order',
        method: 'POST',
        path: '/store/admin/orders/:id/refund',
        permission: 'store.admin',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'amount', type: 'integer', min: 1, max: 2000000000 },
          { name: 'reason', type: 'string', maxLength: 191 },
        ],
      },
      {
        id: 'store.create-product',
        method: 'POST',
        path: '/store/admin/products',
        permission: 'store.admin',
        input: [
          { name: 'name', type: 'string', required: true, maxLength: 191 },
          { name: 'description', type: 'string', maxLength: 191 },
          { name: 'price', type: 'integer', required: true, min: 1, max: 2000000000 },
          { name: 'stock', type: 'integer', default: 0, min: 0, max: 1000000 },
          { name: 'cost', type: 'integer', min: 0, max: 2000000000 },
          { name: 'categoryId', type: 'string', maxLength: 191 },
          { name: 'fulfillmentType', type: 'string', maxLength: 64 },
          { name: 'providerId', type: 'string', maxLength: 64 },
          { name: 'providerProductId', type: 'string', maxLength: 191 },
          { name: 'metadata', type: 'string', maxLength: 40000 },
        ],
      },
      {
        id: 'store.update-product',
        method: 'PATCH',
        path: '/store/admin/products/:id',
        permission: 'store.admin',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'name', type: 'string', required: true, maxLength: 191 },
          { name: 'description', type: 'string', maxLength: 191 },
          { name: 'price', type: 'integer', required: true, min: 1, max: 2000000000 },
          { name: 'stock', type: 'integer', default: 0, min: 0, max: 1000000 },
          { name: 'cost', type: 'integer', min: 0, max: 2000000000 },
          { name: 'categoryId', type: 'string', maxLength: 191 },
          { name: 'fulfillmentType', type: 'string', maxLength: 64 },
          { name: 'providerId', type: 'string', maxLength: 64 },
          { name: 'providerProductId', type: 'string', maxLength: 191 },
          { name: 'metadata', type: 'string', maxLength: 40000 },
        ],
      },
    ],
    adminWidgets: { 'store-summary': StoreSummaryWidget },
    adminRoutes: [
      {
        path: '/overview',
        component: 'admin/summary',
        permission: 'store.admin',
        nav: { label: '概览', group: '商店', order: 0 },
        data: [
          { finder: 'store.adminSummary', as: 'summary' },
          { finder: 'store.productTypes', as: 'productTypes' },
        ],
      },
      {
        path: '/products',
        component: 'admin/overview',
        permission: 'store.admin',
        nav: { label: '商品', group: '商店', order: 10, activePaths: ['/products'] },
        data: [
          { finder: 'store.adminProducts', as: 'products' },
          { finder: 'store.productTypes', as: 'productTypes' },
          { finder: 'store.upstreamSources', as: 'upstreamSources' },
          { finder: 'catalog.adminCategories', as: 'categories' },
          { finder: 'catalog.adminProducts', as: 'catalogProducts' },
        ],
      },
      {
        path: '/products/new',
        component: 'admin/product-editor',
        permission: 'store.admin',
        data: [
          { finder: 'store.productTypes', as: 'productTypes' },
          { finder: 'store.upstreamSources', as: 'upstreamSources' },
          { finder: 'catalog.adminCategories', as: 'categories' },
          { finder: 'store.currencies', as: 'currencies' },
        ],
      },
      {
        path: '/products/:id/edit',
        component: 'admin/product-editor',
        permission: 'store.admin',
        data: [
          { finder: 'store.adminProduct', as: 'product', input: { id: ':id' } },
          {
            finder: 'store.adminProductCategoryIds',
            as: 'productCategoryIds',
            input: { id: ':id' },
          },
          { finder: 'store.productTypes', as: 'productTypes' },
          { finder: 'store.upstreamSources', as: 'upstreamSources' },
          { finder: 'catalog.adminCategories', as: 'categories' },
          { finder: 'store.currencies', as: 'currencies' },
        ],
      },
    ],
    accountRoutes: [
      {
        path: '/services',
        component: 'account/services',
        permission: 'store.view',
        nav: { label: '我的云服务', group: '云服务', order: 10 },
        data: [{ finder: 'store.myServices', as: 'services' }],
      },
      {
        path: '/orders',
        component: 'account/orders',
        permission: 'store.view',
        nav: { label: '订单', group: '费用', order: 20 },
        data: [{ finder: 'store.myOrders', as: 'orders' }],
      },
      {
        path: '/services/:id',
        component: 'account/service-detail',
        permission: 'store.view',
        data: [
          { finder: 'store.myService', as: 'service', input: { id: ':id' } },
          { finder: 'store.myServiceMetrics', as: 'metrics', input: { id: ':id' } },
          { finder: 'store.myServiceResources', as: 'resources', input: { id: ':id' } },
          { finder: 'store.myServiceChangeOptions', as: 'changeOptions', input: { id: ':id' } },
          {
            finder: 'store.myServiceChangeQuote',
            as: 'changeQuote',
            input: { id: ':id', $query: '1' },
          },
        ],
      },
    ],
    accountPages: {
      'account/orders': StoreAccountOrdersPage,
      'account/services': StoreAccountServicesPage,
      'account/service-detail': StoreAccountServiceDetailPage,
    },
  },
};

export default frontend;
