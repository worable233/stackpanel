import type { FrontendPageComponent, FrontendPageProps } from '@stackpanel/sdk';
import {
  CommerceCart,
  Input,
  Reveal,
  SidebarMenu,
  SidebarMenuLink,
  Spotlight,
  Stepper,
} from '@stackpanel/ui';
import type { ReactElement } from 'react';
import Link from 'next/link';
import Form from 'next/form';
interface StoreProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  status: string;
  metadata: Record<string, unknown> | null;
  originalPrice?: number | null;
  discount?: number | null;
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
  qtyMin?: number;
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

interface CartItem {
  summary?: string;
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
    metadata?: Record<string, unknown> | null;
  };
}

interface CatalogProductsResult {
  products: CatalogEntry[];
  total: number;
  page: number;
  pageSize: number;
  categoryId: string | null;
  query?: string | null;
}

/** Dependency-free inline icons — the bundle keeps no icon dependency. */
import {
  ArrowRight,
  Check,
  Layers,
  Cpu,
  MemoryStick,
  HardDrive,
  Network,
  Globe,
  Activity,
  MapPin,
  Info,
  Search,
  ChevronDown,
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
  const specs = product.metadata?.specs;
  const rows =
    specs && typeof specs === 'object' && !Array.isArray(specs)
      ? Object.entries(specs).filter((row): row is [string, string | number | boolean] =>
          ['string', 'number', 'boolean'].includes(typeof row[1]),
        )
      : [];
  const cycle = product.metadata?.billingCycle;
  const cycleLabel =
    typeof cycle === 'string'
      ? (
          {
            monthly: '月',
            quarterly: '季',
            semiannually: '半年',
            annually: '年',
            yearly: '年',
          } as Record<string, string>
        )[cycle]
      : undefined;
  const available = product.stock > 0 && product.status === 'ACTIVE';
  return (
    <Reveal className="h-full">
      <Spotlight>
        <article className="flex h-full flex-col bg-foreground/[0.025] backdrop-blur-xl">
          <div className="flex min-h-20 items-center justify-between gap-3 border-b border-foreground/10 bg-foreground/[0.025] px-5 py-5">
            <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
              <Link href={`/shop/${product.id}`} className="transition-colors hover:text-primary">
                {product.name}
              </Link>
            </h2>
            <span className="shrink-0 border-l border-foreground/10 pl-3 text-xs tabular-nums text-muted-foreground">
              {available ? `库存 ${product.stock}` : '已售罄'}
            </span>
          </div>
          <div className="flex flex-1 flex-col gap-6 p-5">
            {product.description ? (
              <p className="text-xs leading-6 text-muted-foreground">{product.description}</p>
            ) : null}
            {rows.length ? (
              <dl className="flex flex-col gap-5 text-sm">
                {rows.map(([label, value]) => (
                  <div
                    key={label}
                    className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-3"
                  >
                    <dt className="flex items-center gap-2 text-muted-foreground">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-primary/15 bg-primary/10 text-primary">
                        {specIcon(label)}
                      </span>
                      <span className="break-words text-xs">{label}</span>
                    </dt>
                    <dd className="min-w-0 break-words pt-1 text-xs font-medium leading-6">
                      {String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs leading-6 text-muted-foreground">
                详细配置与可选项请查看产品说明。
              </p>
            )}
            <div className="mt-auto flex flex-wrap items-baseline gap-2 border-t border-foreground/10 pt-5">
              <span className="text-3xl text-primary">
                <PriceTag amount={product.price} currency={product.currency} />
              </span>
              {cycleLabel ? (
                <span className="text-xs text-muted-foreground">/ {cycleLabel}</span>
              ) : null}
            </div>
          </div>
          {available ? (
            <Link
              href={`/shop/${product.id}`}
              className="flex h-12 items-center justify-center gap-2 border-t border-primary/20 bg-primary/10 text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
            >
              选择配置 <ArrowRight className="size-4" />
            </Link>
          ) : (
            <span
              aria-disabled="true"
              className="flex h-12 items-center justify-center border-t border-foreground/10 bg-muted/30 text-sm text-muted-foreground"
            >
              暂时售罄
            </span>
          )}
        </article>
      </Spotlight>
    </Reveal>
  );
}

function specIcon(label: string): ReactElement {
  const IconComponent = /cpu|处理器|核心/i.test(label)
    ? Cpu
    : /内存|memory|ram/i.test(label)
      ? MemoryStick
      : /磁盘|系统盘|硬盘|存储|ssd|disk/i.test(label)
        ? HardDrive
        : /带宽|流量|bandwidth|traffic/i.test(label)
          ? Network
          : /线路|network/i.test(label)
            ? Activity
            : /ip|地址/i.test(label)
              ? Globe
              : /地区|区域|地域|region/i.test(label)
                ? MapPin
                : Info;
  return <IconComponent aria-hidden className="size-4" />;
}

export function ProductListPage(props: FrontendPageProps): ReactElement {
  const products = (props.data.products as StoreProduct[] | undefined) ?? [];
  const categories = (props.data.categories as CatalogCategoryNode[] | undefined) ?? [];
  const catalogResult = props.data.catalogProducts as CatalogProductsResult | undefined;
  const activeId = catalogResult?.categoryId ?? undefined;
  const activeCategory = activeId ? findCategoryNode(categories, activeId) : null;
  const hasCatalog = categories.length > 0;
  const query = catalogResult?.query ?? '';
  const entries = hasCatalog
    ? (catalogResult?.products ?? []).map(({ product }) => toStoreProduct(product))
    : products;
  const total = hasCatalog ? (catalogResult?.total ?? entries.length) : entries.length;
  const settings = props.settings as { shop?: { showAllProducts?: boolean } };
  const showAll = settings.shop?.showAllProducts === true;
  const categoryNav = (
    <nav aria-label="商品分类" className="px-1 py-2">
      <SidebarMenu>
        {showAll || !hasCatalog ? (
          <li>
            <SidebarMenuLink render={<Link href="/shop?showAll=1" />} active={!activeId}>
              <Layers aria-hidden />
              <span>全部产品</span>
            </SidebarMenuLink>
          </li>
        ) : null}
        {categories.map((node) => (
          <CategoryLink key={node.id} node={node} activeId={activeId} />
        ))}
      </SidebarMenu>
    </nav>
  );
  return (
    <main className="relative mx-auto w-full max-w-[1680px] flex-1 px-5 pb-24 pt-28 sm:px-8 lg:px-10">
      <Reveal className="flex flex-wrap items-center justify-between gap-5 border-b border-foreground/10 pb-7">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {activeCategory?.name ?? '选择你的云产品'}
          </h1>
        </div>
        <Link
          href="/shop/cart"
          className="inline-flex h-10 items-center gap-2 rounded-full border border-foreground/10 bg-foreground/5 px-5 text-sm transition-colors hover:border-primary/40 hover:bg-primary/10"
        >
          <ShoppingCart className="size-4" /> 购物车 <ArrowRight className="size-4" />
        </Link>
      </Reveal>
      <div className="mt-7 grid items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="min-w-0 lg:sticky lg:top-24">
          <Reveal>
            <div>
              {hasCatalog ? (
                <Form
                  key={`${activeId ?? 'all'}-${query}`}
                  action="/shop"
                  className="mb-5 flex flex-col gap-3 px-1"
                >
                  <label htmlFor="catalog-search" className="text-xs text-muted-foreground">
                    查找云产品
                  </label>
                  {activeId ? (
                    <input type="hidden" name="categoryId" value={activeId} />
                  ) : showAll ? (
                    <input type="hidden" name="showAll" value="1" />
                  ) : null}
                  <div className="relative">
                    <Search
                      aria-hidden
                      className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      id="catalog-search"
                      name="q"
                      defaultValue={query}
                      placeholder="产品名称 / 关键词"
                      className="h-10 pl-9"
                    />
                  </div>
                  <button
                    type="submit"
                    className="h-9 rounded-lg border border-foreground/10 text-xs transition-colors hover:bg-primary/10"
                  >
                    搜索当前分类
                  </button>
                </Form>
              ) : null}
              <div className="hidden lg:block">
                <p className="px-4 pb-2 text-xs font-medium text-muted-foreground/70">产品分类</p>
                {categoryNav}
              </div>
              <details className="group/mobile rounded-lg border border-foreground/10 bg-foreground/[0.015] lg:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
                  产品分类{' '}
                  <ChevronDown className="size-4 transition-transform group-open/mobile:rotate-180" />
                </summary>
                {categoryNav}
              </details>
            </div>
          </Reveal>
        </aside>
        <section className="min-w-0" aria-label="云产品套餐">
          <Reveal className="mb-5">
            {activeId ? <CategoryBreadcrumb categories={categories} activeId={activeId} /> : null}
            {activeCategory?.description ? (
              <div className="mb-5 flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/[0.06] px-5 py-4 text-sm leading-7">
                <Info className="mt-1 size-4 shrink-0 text-primary" />
                <p>{activeCategory.description}</p>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
              <p>
                {query ? `“${query}” · ` : ''}共 {total} 款产品
              </p>
              <span>选择产品后配置并购买</span>
            </div>
          </Reveal>
          {entries.length ? (
            <>
              <div className="grid items-stretch gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {entries.map((product) => (
                  <ProductCard key={product.id} product={product} />
                ))}
              </div>
              {catalogResult ? (
                <Pager
                  page={catalogResult.page}
                  pageSize={catalogResult.pageSize}
                  total={catalogResult.total}
                  categoryId={activeId}
                  query={query}
                  showAll={showAll}
                />
              ) : null}
            </>
          ) : (
            <Empty text={query ? '未找到相关产品' : '暂无产品'} />
          )}
        </section>
      </div>
    </main>
  );
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
  return { ...product, metadata: product.metadata ?? null };
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
  const link = (
    <SidebarMenuLink
      render={<Link href={`/shop?categoryId=${encodeURIComponent(node.id)}`} />}
      active={isActive}
      className={node.children.length ? 'pr-10' : undefined}
    >
      <span className="min-w-0 flex-1 break-words">
        {node.icon ? `${node.icon} ` : ''}
        {node.name}
      </span>
      {node.productCount > 0 ? (
        <span className="shrink-0 text-xs tabular-nums opacity-60">{node.productCount}</span>
      ) : null}
    </SidebarMenuLink>
  );
  return (
    <li className="relative">
      {link}
      {node.children.length ? (
        <details
          key={`${node.id}-${activeId ?? ''}`}
          open={Boolean(activeId && findCategoryNode([node], activeId))}
          className="group/category"
        >
          <summary
            aria-label={`展开或收起${node.name}`}
            className="absolute right-1 top-0.5 flex size-8 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
          >
            <ChevronDown
              aria-hidden
              className="size-3.5 transition-transform group-open/category:rotate-180"
            />
          </summary>
          <SidebarMenu className="mb-1 ml-5 mt-1 border-l border-foreground/10 pl-2">
            {node.children.map((child) => (
              <CategoryLink key={child.id} node={child} activeId={activeId} />
            ))}
          </SidebarMenu>
        </details>
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
  query,
  showAll,
}: {
  page: number;
  pageSize: number;
  total: number;
  categoryId?: string;
  query?: string;
  showAll?: boolean;
}): ReactElement | null {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const filters = new URLSearchParams();
  if (categoryId) filters.set('categoryId', categoryId);
  else if (showAll) filters.set('showAll', '1');
  if (query) filters.set('q', query);
  const categoryQuery = filters.size ? `${filters.toString()}&` : '';
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
    <Form action={`/shop/${product.id}`} className="mt-6 space-y-4 border-t pt-5">
      <div className="grid gap-1.5">
        <label htmlFor="checkout-cycle" className="text-sm font-medium">
          计费周期
        </label>
        <select
          id="checkout-cycle"
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
              <label htmlFor={`checkout-${option.id}`} className="text-sm font-medium">
                {option.label}
                {option.unit ? `（${option.unit}）` : ''}
              </label>
              <input
                id={`checkout-${option.id}`}
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
            <label htmlFor={`checkout-${option.id}`} className="text-sm font-medium">
              {option.label}
            </label>
            <select
              id={`checkout-${option.id}`}
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
    </Form>
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
      <p className="text-xs font-medium text-muted-foreground">已选配置</p>
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

export const ProductDetailPage: FrontendPageComponent = (props) => {
  const product = props.data.product as StoreProduct | undefined;
  const methods = props.data.methods as
    { providers: Array<{ id: string; methods: Array<{ id: string; label: string }> }> } | undefined;
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
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 pb-24 pt-32 sm:px-8 sm:pb-32 sm:pt-40 lg:px-12">
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
        <section
          data-reveal="visible"
          className="overflow-hidden rounded-xl border border-foreground/10 bg-foreground/[0.025] text-foreground backdrop-blur-xl"
        >
          <div className="relative flex h-56 items-center justify-center bg-primary/[0.025] [background-image:radial-gradient(ellipse_at_center,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_70%)]">
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

        <aside
          data-reveal="visible"
          className="h-fit rounded-xl border border-foreground/10 bg-foreground/[0.035] p-6 text-foreground backdrop-blur-xl lg:sticky lg:top-24"
        >
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
                    className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-opacity hover:opacity-90"
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

export function StoreCartPage(props: FrontendPageProps): ReactElement {
  const cart = props.data.cart as CartPayload | undefined;
  const items = cart?.items ?? [];
  const methods = props.data.methods as
    { providers: Array<{ id: string; methods: Array<{ id: string; label: string }> }> } | undefined;
  const wallet = props.actions['store.checkout-wallet'];
  const external = props.actions['store.checkout-external'];
  const payments = [
    ...(wallet ? [{ id: 'wallet', label: '账户余额', action: wallet }] : []),
    ...(external
      ? (methods?.providers ?? []).flatMap((provider) =>
          provider.methods.map((method) => ({
            id: `${provider.id}:${method.id}`,
            label: method.label,
            action: external,
            providerId: provider.id,
            paymentMethod: method.id,
          })),
        )
      : []),
  ];
  return (
    <main className="relative isolate mx-auto w-full max-w-7xl flex-1 px-6 pb-24 pt-32 sm:px-8 sm:pb-32 sm:pt-40 lg:px-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-12 -z-10 h-80 [background:radial-gradient(ellipse_45%_50%_at_45%_50%,color-mix(in_oklch,var(--primary)_8%,transparent),transparent_100%)] sm:top-20"
      />
      <Reveal className="relative">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">购物车</h1>
          <Stepper
            label="购买步骤"
            steps={['购物车', '确认订单', '完成支付']}
            currentStep={0}
            className="w-full sm:w-80 lg:w-96"
          />
        </div>
      </Reveal>
      {items.length ? (
        <CommerceCart
          items={items.map((item) => ({
            id: item.id,
            name: item.product.name,
            quantity: item.quantity,
            stock: item.product.stock,
            total: item.total,
            currency: item.product.currency,
            summary: item.summary,
            available: item.product.status === 'ACTIVE',
            productLink: (
              <Link
                href={`/shop/${item.productId}`}
                className="transition-colors hover:text-primary"
              >
                {item.product.name}
              </Link>
            ),
          }))}
          payments={payments}
          updateQuantity={props.actions['store.update-cart-item']}
          removeItem={props.actions['store.remove-cart-item']}
          continueShopping={
            <Link
              href="/shop"
              className="inline-flex items-center gap-2 transition-colors hover:text-foreground"
            >
              <ArrowRight className="size-4 rotate-180" />
              继续选购
            </Link>
          }
        />
      ) : (
        <Reveal className="mt-12">
          <Spotlight>
            <section className="flex min-h-60 flex-col items-center justify-center gap-5 bg-foreground/[0.025] px-6 py-12 text-center">
              <ShoppingCart
                aria-hidden="true"
                className="size-8 text-muted-foreground/60"
                strokeWidth={1.5}
              />
              <h2 className="text-lg font-semibold">暂无产品</h2>
            </section>
          </Spotlight>
        </Reveal>
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
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-6 pb-24 pt-40 text-center">
      <p className="bg-linear-to-r from-primary to-primary/40 bg-clip-text font-mono text-5xl font-bold text-transparent">
        404
      </p>
      <p className="mt-4 text-sm text-muted-foreground">服务不存在或已下架。</p>
      <Link
        href="/shop"
        className="mt-8 inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-opacity hover:opacity-90"
      >
        返回服务目录
        <Icon name="arrow" />
      </Link>
    </main>
  );
}
function Empty({ text }: { text: string }): ReactElement {
  return (
    <div
      data-reveal="visible"
      className="flex min-h-60 flex-col items-center justify-center gap-5 rounded-xl border border-foreground/10 bg-foreground/[0.025] px-6 py-12 text-center"
    >
      <Package aria-hidden="true" className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
      <p className="text-lg font-semibold">{text}</p>
    </div>
  );
}
