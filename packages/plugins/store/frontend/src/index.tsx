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
}

interface CheckoutChoice {
  id: string;
  label: string;
  price?: number;
}

interface CheckoutOption {
  id: string;
  label: string;
  type: 'select' | 'quantity';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
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

const productListSchema = z.object({ products: z.array(storeProductSchema) });
const productSchema = z.object({ product: storeProductSchema });
const orderListSchema = z.object({ orders: z.array(storeOrderSchema) });

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
const serviceActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  danger: z.boolean().optional(),
  confirm: z.boolean().optional(),
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

function money(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
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
  const [int, dec] = (amount / 100).toFixed(2).split('.');
  return (
    <span className="font-mono font-bold tracking-tight tabular-nums">
      <span className="align-super text-[0.65em] font-medium opacity-80">{currency} </span>
      <span>{int}</span>
      <span className="text-[0.75em] opacity-80">.{dec}</span>
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
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              挑选心仪的服务，加入购物车或直接结算。
            </p>
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

/** 默认选择：第一个周期；每个 select 选项选第一个可选值；quantity 取 min。 */
function defaultSelection(config: CheckoutConfig | null): Selection | null {
  if (!config) return null;
  const selections: Record<string, string | number> = {};
  for (const option of config.options) {
    const first = option.choices?.[0];
    if (option.type === 'quantity') {
      const min = option.min ?? first?.qtyMin ?? 0;
      if (first) selections[option.id] = min;
    } else if (first) {
      selections[option.id] = first.id;
    }
  }
  return { cycle: config.cycles[0]?.id, ...(Object.keys(selections).length ? { selections } : {}) };
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
  return (
    <form method="get" action={`/shop/${product.id}`} className="mt-6 space-y-4 border-t pt-5">
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
      {config.options.map((option) => {
        const current = sel[option.id];
        if (option.type === 'quantity') {
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
            </div>
          );
        }
        return (
          <div key={option.id} className="grid gap-1.5">
            <label className="text-sm font-medium">{option.label}</label>
            <select
              name={`cfg_${option.id}`}
              defaultValue={typeof current === 'string' ? current : (option.choices?.[0]?.id ?? '')}
              className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
            >
              {(option.choices ?? []).map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
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
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">商店</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">购物车</h1>
          <p className="mt-2 text-sm text-muted-foreground">勾选要结算的商品，然后选择支付方式。</p>
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
                <PriceTag amount={cart?.total ?? 0} currency="CNY" />
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
      <PageHeader title="历史订单" description="查看购买记录与支付状态。" />
      {orders.length ? (
        <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
          {orders.map((order) => (
            <li
              key={order.id}
              className="grid gap-3 px-5 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto] sm:items-center sm:px-6"
            >
              <span className="truncate font-mono text-xs text-muted-foreground">{order.id}</span>
              <span className="font-mono font-semibold">{money(order.total, order.currency)}</span>
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
      <PageHeader title="我的云服务" description="查看已购买的云服务器等服务及其状态。" />
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
  if (!service) return <Empty text="服务不存在" />;
  const fields = service.detail?.fields ?? [];
  const actions = service.detail?.actions ?? [];
  return (
    <main className="space-y-6">
      <PageHeader
        title={service.detail?.title ?? service.productName}
        description={service.productName}
      />
      <div className="flex items-center gap-3">
        <ServiceStatusBadge
          status={service.detail?.status ?? service.status}
          label={service.detail?.statusLabel}
        />
        <span className="font-mono text-xs text-muted-foreground">{service.id}</span>
      </div>

      {fields.length ? (
        <dl className="grid gap-px overflow-hidden rounded-2xl border bg-border/60 sm:grid-cols-2">
          {fields.map((field) => (
            <div key={field.label} className="bg-card p-4">
              <dt className="text-xs text-muted-foreground">{field.label}</dt>
              <dd className="mt-1 break-all font-mono text-sm">
                {field.secret ? '••••••••' : field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {actions.length && runAction ? (
        <div className="flex flex-wrap gap-3">
          {actions.map((action) => (
            <form key={action.id} action={runAction}>
              <input type="hidden" name="id" value={service.id} />
              <input type="hidden" name="actionId" value={action.id} />
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
          ))}
        </div>
      ) : null}

      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">监控</h2>
        <MetricsChart series={metrics} />
      </div>
    </main>
  );
}

function OrderStatus({ status }: { status: string }): ReactElement {
  const tone =
    status === 'PENDING'
      ? 'bg-warning/10 text-warning'
      : status === 'COMPLETED' || status === 'PAID'
        ? 'bg-success/10 text-success'
        : status === 'CANCELLED' || status === 'FAILED'
          ? 'bg-destructive/10 text-destructive'
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
    <section className="rounded-2xl border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="text-sm font-semibold">商店概览</h2>
    </section>
  );
}

const storeFinders: Record<string, FinderProvider> = {
  'store.products': {
    handler: async (input, ctx) =>
      (
        await ctx.api.get(
          `/products?page=${typeof input.page === 'number' ? input.page : 1}&pageSize=${typeof input.pageSize === 'number' ? input.pageSize : 20}`,
          productListSchema,
        )
      ).products,
  },
  'store.product': {
    handler: async (input, ctx) =>
      (
        await ctx.api.get(
          `/products/${encodeURIComponent(typeof input.id === 'string' ? input.id : '')}`,
          productSchema,
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
  'store.adminProducts': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/store/admin/products?page=1&pageSize=50', productListSchema)).products,
  },
  'store.productTypes': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/store/product-types', productTypeListSchema)).types,
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
          input: { page: 1, pageSize: 60, categoryId: '', showAll: '' },
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
        component: 'admin/overview',
        permission: 'store.admin',
        nav: { label: '商店管理', group: '商店插件' },
        data: [
          { finder: 'store.adminProducts', as: 'products' },
          { finder: 'store.productTypes', as: 'productTypes' },
          { finder: 'store.upstreamSources', as: 'upstreamSources' },
          { finder: 'catalog.adminCategories', as: 'categories' },
          { finder: 'catalog.adminProducts', as: 'catalogProducts' },
        ],
      },
    ],
    accountRoutes: [
      {
        path: '/services',
        component: 'account/services',
        permission: 'store.view',
        nav: { label: '我的云服务', group: '服务' },
        data: [{ finder: 'store.myServices', as: 'services' }],
      },
      {
        path: '/orders',
        component: 'account/orders',
        permission: 'store.view',
        nav: { label: '历史订单', group: '费用' },
        data: [{ finder: 'store.myOrders', as: 'orders' }],
      },
      {
        path: '/services/:id',
        component: 'account/service-detail',
        permission: 'store.view',
        data: [
          { finder: 'store.myService', as: 'service', input: { id: ':id' } },
          { finder: 'store.myServiceMetrics', as: 'metrics', input: { id: ':id' } },
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
