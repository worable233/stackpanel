import { SectionTitle } from '@stackpanel/ui';
import {
  formatMinorCurrency,
  minorUnitFor,
  minorUnitsToPlainString,
  PACKAGE_FALLBACK_LOCALE,
} from '@stackpanel/sdk';
import type {
  AccountPageComponentProps,
  AdminWidgetProps,
  FinderProvider,
  FrontendPackage,
  FrontendPageProps,
  FrontendActionExecutor,
} from '@stackpanel/sdk';
import {
  PageHeader,
  Button,
  Input,
  Field,
  FieldGroup,
  Select,
  Slider,
  ConfigurationSlider,
  ConfigurationQuantity,
  ConfigurationImages,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  InlineError,
  InlineNotice,
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  CopyButton,
  SecretValue,
  MetricsExplorer,
} from '@stackpanel/ui';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowUpRight,
  PackageOpen,
  Search,
  ArrowLeft,
  Cpu,
  MemoryStick,
  HardDrive,
  ArrowUp,
  ArrowDown,
  Monitor,
  Power,
  RotateCw,
  Square,
  KeyRound,
  CalendarDays,
  Activity,
  Settings2,
  ChevronDown,
  Pencil,
  Wrench,
  Clock,
  TriangleAlert,
} from 'lucide-react';
import { z } from 'zod';
import { messages, t } from './i18n.js';
import { AutoSubmitForm, CartCheckout } from './auto-submit.js';
import { reconcileSelection } from './checkout-model.js';
import {
  canManageService,
  isPublicIpLabel,
  serviceDate,
  serviceDisplayName,
  serviceExpiryState,
  serviceInstanceName,
  serviceRemark,
} from './service-presentation.js';

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
  originalPrice?: number | null;
  discount?: number | null;
  purchasable?: boolean;
  unavailableReason?: 'inactive' | 'out_of_stock' | 'forbidden' | null;
}

interface CheckoutCycle {
  id: string;
  label: string;
  price: number;
  renewPrice?: number;
  months?: number;
}

interface CheckoutChoice {
  qtyMin?: number;
  qtyMax?: number;
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
  originalTotal?: number | undefined;
  productId: string;
  price: number;
  /** 未打折单价（`price` 已扣折扣）；服务端按 discount.ts 计算。 */
  basePrice?: number | undefined;
  discount?: number | null | undefined;
  currency: string;
  quantity: number;
  total: number;
  settlementCurrency?: string | undefined;
  settlementTotal?: number | undefined;
  fxRate?: number | null | undefined;
  renewPrice?: number | undefined;
  breakdown?: Array<{ label: string; value: string; price?: number | undefined }> | undefined;
  summary?: string | undefined;
}

interface StorePayment {
  id: string;
  providerId: string | null;
  paymentMethod: string | null;
  paymentUrl: string | null;
  status: string;
}

interface StoreOrderLine {
  productId: string;
  name: string;
  price: number;
  currency: string;
  quantity: number;
  description?: string | undefined;
  config?: unknown;
}

interface StoreOrder {
  id: string;
  total: number;
  currency: string;
  /** Frozen settlement snapshot (plan §5.2). */
  settlementCurrency?: string | undefined;
  settlementTotal?: number | undefined;
  status: string;
  /** Snapshot of the purchased lines: `{ items: StoreOrderLine[] }`. */
  items?: { items?: StoreOrderLine[] | undefined } | null | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  channelCode?: string | null | undefined;
  payment?: StorePayment | null;
}

interface StorePaymentInstructions {
  kind: string;
  message: string;
  detail?: Record<string, unknown> | null | undefined;
}

interface StoreOrderDetail extends StoreOrder {
  createdAt: string;
  updatedAt: string;
  paymentUrl?: string | null | undefined;
  paymentInstructions?: StorePaymentInstructions | null | undefined;
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
  config?: unknown;
  unavailableReason?: string | undefined;
  summary?: string | undefined;
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

interface AccountCategoryNode {
  id: string;
  name: string;
  children: AccountCategoryNode[];
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
  quoteAvailable: z.boolean().optional(),
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
        // 未打折单价与生效折扣：服务端按 `discount.ts` 算，前端只展示。
        originalPrice: z.number().optional(),
        discount: z.number().nullable().optional(),
        currency: z.string(),
        stock: z.number(),
        status: z.string(),
        createdAt: z.string(),
      }),
      total: z.number(),
      config: z.unknown().optional(),
      summary: z.string().optional(),
      unavailableReason: z.string().optional(),
    }),
  ),
  total: z.number(),
});

const pricePreviewSchema = z.object({
  originalTotal: z.number().optional(),
  productId: z.string(),
  price: z.number(),
  // 未打折单价（`price` 已扣折扣）。服务端算，前端只负责展示划线价。
  basePrice: z.number().optional(),
  discount: z.number().nullable().optional(),
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

const storeOrderLineSchema = z.object({
  productId: z.string(),
  name: z.string(),
  price: z.number(),
  currency: z.string(),
  quantity: z.number(),
  description: z.string().optional(),
  config: z.unknown().optional(),
});

const storeOrderSchema = z.object({
  id: z.string(),
  total: z.number(),
  currency: z.string(),
  settlementCurrency: z.string().optional(),
  settlementTotal: z.number().optional(),
  status: z.string(),
  items: z
    .object({
      items: z.array(storeOrderLineSchema).optional(),
    })
    .nullable()
    .optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  channelCode: z.string().nullable().optional(),
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

const storePaymentInstructionsSchema = z.object({
  kind: z.string(),
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable().optional(),
});

const orderDetailSchema = z.object({
  order: storeOrderSchema.extend({
    createdAt: z.string(),
    updatedAt: z.string(),
    paymentUrl: z.string().nullable().optional(),
    paymentInstructions: storePaymentInstructionsSchema.nullable().optional(),
  }),
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
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
const purchasableProductSchema = z.object({ product: storePurchasableProductSchema });
const orderListSchema = z.object({
  orders: z.array(storeOrderSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

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

const accountCategoryNodeSchema: z.ZodType<AccountCategoryNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string().nullable().optional(),
    sortOrder: z.number().optional(),
    providerId: z.string().nullable().optional(),
    fulfillmentTypes: z.array(z.string()).optional(),
    children: z.array(accountCategoryNodeSchema),
  }),
);
const categoryListSchema = z.object({ categories: z.array(accountCategoryNodeSchema) });

const serviceSummarySchema = z.object({
  configuration: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
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
    renewal: z
      .object({
        price: z.number(),
        currency: z.string(),
        months: z.number(),
        cycle: z.string().nullable(),
      })
      .nullable()
      .optional(),
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
      labelKey: 'settings.shop.group',
      fields: [
        {
          type: 'number',
          name: 'productsPerPage',
          labelKey: 'settings.shop.productsPerPage.label',
          default: 12,
          min: 1,
          max: 60,
        },
        {
          type: 'boolean',
          name: 'showAllProducts',
          labelKey: 'settings.shop.showAllProducts.label',
          helpKey: 'settings.shop.showAllProducts.help',
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
function money(amount: number, currency: string, locale: string | undefined): string {
  try {
    // The host negotiates the locale; zh-CN is the same catalog fallback `t()` uses.
    return formatMinorCurrency(amount, currency, locale ?? PACKAGE_FALLBACK_LOCALE);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** Fulfillment type -> message id. Values are persisted API codes, not copy. */
const FULFILLMENT_LABELS: Record<string, string> = {
  upstream_service: 'fulfillment.upstreamService',
  card: 'fulfillment.card',
  instant: 'fulfillment.instant',
  api_token: 'fulfillment.apiToken',
  membership: 'fulfillment.membership',
  physical: 'fulfillment.physical',
  donation: 'fulfillment.donation',
  topup: 'fulfillment.topup',
};

function fulfillmentLabel(type: string, tr: ReturnType<typeof t>): string {
  if (type === 'cloud_server') return tr('fulfillment.cloudServer');
  const key = FULFILLMENT_LABELS[type];
  return key ? tr(key) : type;
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

function StockBadge({ stock, tr }: { stock: number; tr: ReturnType<typeof t> }): ReactElement {
  return stock > 0 ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
      <span className="size-1.5 rounded-full bg-current" />
      {tr('stock.inStock')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      <span className="size-1.5 rounded-full bg-current" />
      {tr('stock.outOfStock')}
    </span>
  );
}

function ProductCard({
  product,
  tr,
  locale,
}: {
  product: StoreProduct;
  tr: ReturnType<typeof t>;
  locale: string | undefined;
}): ReactElement {
  return (
    <Link
      href={`/account/store/${encodeURIComponent(product.id)}`}
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
        <StockBadge stock={product.stock} tr={tr} />
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
            {money(product.price, product.currency, locale)}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors group-hover:text-primary">
          {tr('catalog.viewDetails')}
          <span className="transition-transform group-hover:translate-x-0.5">
            <Icon name="arrow" />
          </span>
        </span>
      </div>
    </Link>
  );
}

function ProductListPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
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
              {activeId ? findCategoryName(categories, activeId, tr) : tr('catalog.title')}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/account/store/cart"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-4 text-sm font-semibold text-background shadow-sm transition-opacity hover:opacity-90"
            >
              <Icon name="cart" />
              {tr('catalog.cart')}
            </Link>
          </div>
        </div>
      </div>
      {hasCatalog ? (
        <div className="mt-10 grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="h-fit rounded-2xl border bg-card p-4 shadow-sm lg:sticky lg:top-20">
            <nav aria-label={tr('catalog.categoriesAria')}>
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
                  {tr('catalog.allCategories')}
                </Link>
              ) : null}
              <ul className="mt-1 space-y-0.5">
                {categories.map((node) => (
                  <CategoryLink key={node.id} node={node} activeId={activeId} tr={tr} />
                ))}
              </ul>
            </nav>
          </aside>
          <section>
            {activeId ? (
              <CategoryBreadcrumb categories={categories} activeId={activeId} tr={tr} />
            ) : null}
            {entries.length ? (
              <>
                <p className="mb-4 text-sm text-muted-foreground">
                  {tr('catalog.total', { count: total })}
                </p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {entries.map(({ product }) => (
                    <ProductCard
                      key={product.id}
                      product={toStoreProduct(product)}
                      tr={tr}
                      locale={props.locale}
                    />
                  ))}
                </div>
                {catalogResult ? (
                  <Pager
                    page={catalogResult.page}
                    pageSize={catalogResult.pageSize}
                    total={catalogResult.total}
                    categoryId={activeId}
                    tr={tr}
                  />
                ) : null}
              </>
            ) : (
              <Empty text={tr('catalog.emptyCategory')} />
            )}
          </section>
        </div>
      ) : products.length ? (
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} tr={tr} locale={props.locale} />
          ))}
        </div>
      ) : (
        <div className="mt-10">
          <p className="py-8 text-center text-sm text-muted-foreground">{tr('catalog.empty')}</p>
        </div>
      )}
    </main>
  );
}

/** Find a category name in the tree (used for the page heading). */
function findCategoryName(
  categories: readonly CatalogCategoryNode[],
  activeId: string,
  tr: ReturnType<typeof t>,
): string {
  const found = findCategoryNode(categories, activeId);
  return found?.name ?? tr('catalog.title');
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
  tr,
}: {
  node: CatalogCategoryNode;
  activeId: string | undefined;
  tr: ReturnType<typeof t>;
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
            <CategoryLink key={child.id} node={child} activeId={activeId} tr={tr} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function CategoryBreadcrumb({
  categories,
  activeId,
  tr,
}: {
  categories: readonly CatalogCategoryNode[];
  activeId: string;
  tr: ReturnType<typeof t>;
}): ReactElement | null {
  const path = findCategoryPath(categories, activeId);
  if (!path) return null;
  return (
    <nav
      aria-label={tr('catalog.breadcrumbAria')}
      className="mb-4 flex flex-wrap items-center gap-1 text-sm text-muted-foreground"
    >
      <Link href="/shop" className="hover:text-foreground hover:underline">
        {tr('catalog.allServices')}
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
  tr,
}: {
  page: number;
  pageSize: number;
  total: number;
  categoryId: string | undefined;
  tr: ReturnType<typeof t>;
}): ReactElement | null {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const categoryQuery = categoryId ? `categoryId=${encodeURIComponent(categoryId)}&` : '';
  return (
    <nav className="mt-8 flex items-center justify-between border-t pt-4 text-sm">
      <span className="text-muted-foreground">
        {tr('catalog.pagerSummary', { total, page, pages })}
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
            {tr('catalog.previous')}
          </Link>
        ) : (
          <span className="inline-flex h-9 items-center gap-1.5 rounded-xl border bg-muted px-3.5 text-sm text-muted-foreground">
            <span className="rotate-180 opacity-50">
              <Icon name="arrow" />
            </span>
            {tr('catalog.previous')}
          </span>
        )}
        {page < pages ? (
          <Link
            href={`/shop?${categoryQuery}page=${page + 1}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border bg-card px-3.5 text-sm font-medium shadow-sm transition-colors hover:bg-muted"
          >
            {tr('catalog.next')}
            <Icon name="arrow" />
          </Link>
        ) : (
          <span className="inline-flex h-9 items-center gap-1.5 rounded-xl border bg-muted px-3.5 text-sm text-muted-foreground">
            {tr('catalog.next')}
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
  instanceName?: string;
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
  config?: CheckoutConfig | null,
): Selection | null {
  const cycle = typeof query['cycle'] === 'string' && query['cycle'] ? query['cycle'] : undefined;
  const selections: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('cfg_')) continue;
    const optionId = key.slice(4);
    if (!optionId || typeof value !== 'string' || value === '') continue;
    selections[optionId] =
      config?.options.find((option) => option.id === optionId)?.type === 'quantity'
        ? Number(value)
        : value;
  }
  const instanceName = typeof query.instanceName === 'string' ? query.instanceName.trim() : '';
  if (!cycle && !instanceName && Object.keys(selections).length === 0) return null;
  return {
    ...(instanceName ? { instanceName } : {}),
    ...(cycle ? { cycle } : {}),
    ...(Object.keys(selections).length ? { selections } : {}),
  };
}

/** 计算价格表单：GET 提交到本页，query 由 pricePreview finder 读取。 */
function CheckoutConfigForm({
  product,
  config,
  selection,
  tr,
  locale,
}: {
  product: StoreProduct;
  config: CheckoutConfig;
  selection: Selection | null;
  quantity?: number;
  tr: ReturnType<typeof t>;
  locale: string | undefined;
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
    <form
      id="product-selection"
      method="get"
      action={`/account/store/${encodeURIComponent(product.id)}`}
      className="flex flex-col gap-8 py-7"
    >
      <AutoSubmitForm formId="product-selection" />
      <input type="hidden" name="productId" value={product.id} />
      {groups.map((group) => (
        <fieldset
          key={group.name || 'default'}
          className="grid min-w-0 gap-4 md:grid-cols-[7.5rem_minmax(0,1fr)]"
        >
          {group.name ? <legend className="sr-only">{group.name}</legend> : null}
          <h2 className="text-sm font-medium">{group.name || tr('configure.options')}</h2>
          <FieldGroup className="min-w-0 gap-6">
            {group.options.map((option) => {
              const current = sel[option.id];
              if (option.type === 'quantity') {
                const unit = choicePrice(
                  allowedChoices(option, sel, cycle)[0] ?? { id: '', label: '' },
                  cycle,
                );
                return (
                  <Field key={option.id} className="flex flex-col gap-2">
                    <label htmlFor={`option-${option.id}`} className="text-sm font-medium">
                      {option.label}
                      {option.unit ? `（${option.unit}）` : ''}
                    </label>
                    <div className="flex flex-col gap-2">
                      <ConfigurationQuantity
                        key={`${option.id}-${String(current)}`}
                        name={`cfg_${option.id}`}
                        min={option.min ?? 0}
                        max={option.max ?? allowedChoices(option, sel, cycle)[0]?.qtyMax}
                        step={option.step ?? 1}
                        defaultValue={typeof current === 'number' ? current : (option.min ?? 0)}
                        label={option.label}
                        unit={option.unit}
                      />
                      {unit != null ? (
                        <span className="text-[11px] text-muted-foreground">
                          {tr('checkout.unitPrice', {
                            price: money(unit, product.currency, locale),
                            unit: option.unit ?? tr('checkout.unit'),
                          })}
                        </span>
                      ) : null}
                    </div>
                  </Field>
                );
              }
              const choices = allowedChoices(option, sel, cycle);
              const selected =
                (typeof current === 'string' && choices.some((choice) => choice.id === current)
                  ? current
                  : choices[0]?.id) ?? '';
              return (
                <Field key={option.id} className="flex min-w-0 flex-col gap-2">
                  <label htmlFor={`option-${option.id}`} className="text-sm font-medium">
                    {option.label}
                    {option.required ? ' *' : ''}
                  </label>
                  {/操作系统|镜像|operating.system|^os$|image/i.test(`${option.label}`) ? (
                    <ConfigurationImages
                      versionLabel={tr('configure.imageVersion')}
                      otherLabel={tr('configure.otherImages')}
                      key={`${option.id}-${selected}`}
                      name={`cfg_${option.id}`}
                      label={option.label}
                      choices={choices}
                      defaultValue={selected}
                    />
                  ) : /cpu|内存|memory|ram|带宽|bandwidth|系统盘|磁盘|disk|storage|流量|traffic|IP\s*数量|IP\s*(?:count|quantity)|快照数量|snapshot/i.test(
                      `${option.id} ${option.label}`,
                    ) ? (
                    <ConfigurationSlider
                      key={`${option.id}-${selected}`}
                      name={`cfg_${option.id}`}
                      label={option.label}
                      choices={choices}
                      defaultValue={selected}
                    />
                  ) : choices.length === 1 ? (
                    <>
                      <input type="hidden" name={`cfg_${option.id}`} value={selected} />
                      <p
                        id={`option-${option.id}`}
                        className="flex min-h-12 items-center rounded-lg border bg-muted/40 px-3 text-sm"
                      >
                        {choices[0]?.label}
                      </p>
                    </>
                  ) : (
                    <Select
                      id={`option-${option.id}`}
                      name={`cfg_${option.id}`}
                      required={option.required}
                      disabled={choices.length === 0}
                      defaultValue={selected}
                      className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
                    >
                      {choices.map((choice) => {
                        const price = choicePrice(choice, cycle);
                        return (
                          <option key={choice.id} value={choice.id}>
                            {choice.label}
                            {price != null && price > 0
                              ? choice.recurring === false
                                ? tr('checkout.choicePriceFirst', {
                                    price: money(price, product.currency, locale),
                                  })
                                : tr('checkout.choicePrice', {
                                    price: money(price, product.currency, locale),
                                  })
                              : ''}
                          </option>
                        );
                      })}
                    </Select>
                  )}
                  {option.help ? (
                    <span className="text-[11px] text-muted-foreground">{option.help}</span>
                  ) : null}
                </Field>
              );
            })}
          </FieldGroup>
        </fieldset>
      ))}
      {product.fulfillmentType === 'cloud_server' ? (
        <FieldGroup className="grid gap-4 md:grid-cols-[7.5rem_minmax(0,1fr)]">
          <h2 className="text-sm font-medium">{tr('configure.identity')}</h2>
          <Field>
            <label htmlFor="instance-name" className="text-sm font-medium">
              {tr('configure.instanceName')}
            </label>
            <Input
              id="instance-name"
              name="instanceName"
              maxLength={64}
              defaultValue={selection?.instanceName ?? ''}
              placeholder={product.name}
            />
          </Field>
        </FieldGroup>
      ) : null}
    </form>
  );
}

/** 配置价格预览（来自服务端 pricePreview finder）。 */
function CheckoutPricePreview({
  preview,
  currency,
  tr,
  locale,
}: {
  preview: PricePreview;
  currency: string;
  tr: ReturnType<typeof t>;
  locale: string | undefined;
}): ReactElement | null {
  const charged = preview.breakdown?.filter((item) => item.price != null && item.price !== 0) ?? [];
  const hasSettlement =
    preview.settlementCurrency &&
    preview.settlementTotal !== undefined &&
    preview.settlementCurrency !== currency;
  if (!charged.length && !hasSettlement) return null;
  return (
    <div className="flex flex-col gap-3 text-xs">
      {preview.settlementCurrency &&
      preview.settlementTotal !== undefined &&
      preview.settlementCurrency !== currency ? (
        <p className="flex flex-wrap justify-between gap-2 text-muted-foreground">
          <span>{tr('checkout.settlementAmount', { currency: preview.settlementCurrency })}</span>
          <span>{money(preview.settlementTotal, preview.settlementCurrency, locale)}</span>
        </p>
      ) : null}
      {charged.length ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            {tr('configure.priceDetails')}
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {charged.map((item, index) => (
              <li key={index} className="flex justify-between gap-3">
                <span>{item.label}</span>
                <span>{money(item.price!, currency, locale)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * 云服务器尚未声明 checkoutConfig 时，仍使用与实例创建一致的布局展示固定规格。
 * 控件被明确禁用，避免把没有服务端报价契约的字段伪装成可购买配置。
 */
function FixedProductConfiguration({
  product,
  specs,
  tr,
  locale,
}: {
  product: StoreProduct;
  specs: Record<string, unknown> | null;
  tr: ReturnType<typeof t>;
  locale: string | undefined;
}): ReactElement {
  return (
    <FieldGroup className="py-6">
      <Field className="grid gap-4 md:grid-cols-[7.5rem_minmax(0,1fr)]">
        <h2 className="text-sm font-medium">{tr('configure.billing')}</h2>
        <div className="flex flex-col gap-2">
          <p className="text-sm">{tr('configure.fixedPlan')}</p>
          <p className="text-xs text-muted-foreground">
            {money(product.price, product.currency, locale)}
          </p>
        </div>
      </Field>
      {Object.entries(specs ?? {}).map(([key, value]) => (
        <Field key={key} className="grid gap-4 md:grid-cols-[7.5rem_minmax(0,1fr)]">
          <h2 className="text-sm font-medium">{key}</h2>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm">
              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </p>
            {/cpu|内存|memory|ram|带宽|bandwidth|系统盘|磁盘|disk|storage/i.test(key) ? (
              <Slider disabled aria-label={key} defaultValue={[0]} min={0} max={1} />
            ) : null}
          </div>
        </Field>
      ))}
    </FieldGroup>
  );
}

const ProductDetailPage = (
  props: FrontendPageProps & { searchParams?: Record<string, string> },
) => {
  const tr = t(props.locale);
  const product = props.data.product as StoreProduct | undefined;
  if (!product) return <ProductNotFound tr={tr} />;
  const metadata = product.metadata ?? {};
  const specs =
    metadata && typeof metadata.specs === 'object' && metadata.specs !== null
      ? (metadata.specs as Record<string, unknown>)
      : null;
  const checkoutConfig = readCheckoutConfig(metadata);
  const pricePreview = props.data.pricePreview as
    (PricePreview & { selection?: Selection }) | undefined;
  const requestedSelection =
    pricePreview?.selection ??
    selectionFromQuery(props.searchParams ?? {}, checkoutConfig) ??
    defaultSelection(checkoutConfig);
  const currentSelection =
    checkoutConfig && requestedSelection
      ? reconcileSelection(checkoutConfig, requestedSelection)
      : requestedSelection;
  const quantity = purchaseQuantity(props.searchParams?.quantity);
  const canBuy = product.purchasable === true && product.stock >= quantity;
  return (
    <main className="flex min-w-0 w-full flex-col gap-6 pb-80 lg:pb-16">
      <PageHeader
        backHref="/account/store"
        backLabel={tr('product.backToCatalog')}
        title={
          product.fulfillmentType === 'cloud_server'
            ? tr('configure.createInstance')
            : tr('configure.title')
        }
        actions={
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/account/store/cart" />}
          >
            <Icon name="cart" />
            {tr('product.cart')}
          </Button>
        }
      />

      <div className="grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="min-w-0">
          <div className="flex min-w-0 flex-col">
            <div className="hidden">
              <p className="text-xs font-semibold uppercase tracking-widest text-primary">
                {tr('product.kind')}
              </p>
              <div className="flex items-center gap-2">
                {product.fulfillmentType ? (
                  <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    {fulfillmentLabel(product.fulfillmentType, tr)}
                  </span>
                ) : null}
                <StockBadge stock={product.stock} tr={tr} />
              </div>
            </div>
            <h2 className="pt-5 text-base font-semibold">{product.name}</h2>
            {product.description ? (
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{product.description}</p>
            ) : null}
            {checkoutConfig ? (
              <CheckoutConfigForm
                product={product}
                config={checkoutConfig}
                selection={currentSelection}
                tr={tr}
                locale={props.locale}
              />
            ) : (
              <>
                <FixedProductConfiguration
                  product={product}
                  specs={specs}
                  tr={tr}
                  locale={props.locale}
                />
                <form
                  id="product-selection"
                  method="get"
                  action={`/account/store/${encodeURIComponent(product.id)}`}
                >
                  <AutoSubmitForm formId="product-selection" />
                  <input type="hidden" name="productId" value={product.id} />
                </form>
              </>
            )}
          </div>
        </section>

        <aside className="fixed inset-x-0 bottom-0 z-40 mt-0 flex h-fit flex-col gap-3 border-t bg-background/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_color-mix(in_oklab,var(--foreground)_8%,transparent)] backdrop-blur lg:sticky lg:top-20 lg:z-auto lg:mt-2 lg:gap-5 lg:rounded-lg lg:border lg:bg-background lg:p-4 lg:shadow-none">
          <h2 className="hidden text-base font-semibold lg:block">{tr('configure.summary')}</h2>
          <dl className="hidden flex-col gap-3 text-xs lg:flex">
            {currentSelection?.instanceName ? (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{tr('configure.instanceName')}</dt>
                <dd className="min-w-0 break-words text-right">{currentSelection.instanceName}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{tr('configure.product')}</dt>
              <dd className="text-right">{product.name}</dd>
            </div>
            {Object.entries(currentSelection?.selections ?? {}).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-4">
                <dt className="text-muted-foreground">
                  {checkoutConfig?.options.find((option) => option.id === key)?.label ?? key}
                </dt>
                <dd>
                  {checkoutConfig?.options
                    .find((option) => option.id === key)
                    ?.choices?.find((choice) => choice.id === value)?.label ?? String(value)}
                </dd>
              </div>
            ))}
          </dl>
          <FieldGroup className={checkoutConfig ? 'grid grid-cols-2 items-end gap-3' : undefined}>
            <Field>
              <Quantity tr={tr} defaultValue={quantity} form="product-selection" />
            </Field>
            {checkoutConfig ? (
              <Field>
                <label htmlFor="checkout-cycle" className="text-xs text-muted-foreground">
                  {tr('configure.billing')}
                </label>
                <Select
                  id="checkout-cycle"
                  name="cycle"
                  form="product-selection"
                  defaultValue={currentSelection?.cycle ?? checkoutConfig.cycles[0]?.id ?? ''}
                >
                  {checkoutConfig.cycles.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </FieldGroup>
          <noscript>
            <Button type="submit" form="product-selection" variant="outline">
              {tr('checkout.calculatePrice')}
            </Button>
          </noscript>
          <InlineNotice hidden data-quote-status="product-selection" className="text-xs">
            {tr('configure.updating')}
          </InlineNotice>
          {!pricePreview ? (
            <div className="hidden flex-col gap-2 lg:flex">
              <InlineError>{tr('checkout.priceUnavailable')}</InlineError>
              <Button type="submit" form="product-selection" variant="outline">
                {tr('checkout.calculatePrice')}
              </Button>
            </div>
          ) : null}
          <details className="group -mx-1 border-t px-1 pt-3 lg:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
              {tr('configure.details')}
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <dl className="mt-3 flex max-h-[min(16rem,35svh)] flex-col gap-3 overflow-y-auto pr-1 text-xs">
              {currentSelection?.instanceName ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{tr('configure.instanceName')}</dt>
                  <dd className="min-w-0 break-words text-right">
                    {currentSelection.instanceName}
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{tr('configure.product')}</dt>
                <dd className="text-right">{product.name}</dd>
              </div>
              {Object.entries(currentSelection?.selections ?? {}).map(([key, value]) => (
                <div key={key} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">
                    {checkoutConfig?.options.find((option) => option.id === key)?.label ?? key}
                  </dt>
                  <dd className="text-right">
                    {checkoutConfig?.options
                      .find((option) => option.id === key)
                      ?.choices?.find((choice) => choice.id === value)?.label ?? String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
          <div className="flex flex-col gap-2 border-t pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-3xl font-semibold tracking-tight tabular-nums">
                {pricePreview
                  ? money(pricePreview.total, pricePreview.currency, props.locale)
                  : '—'}
              </p>
              {(() => {
                // 折扣来源可能是商品折扣，也可能是权限组折扣（取更优者）。
                // 只读 `product.discount` 会让「按权限组打折」的用户看不到自己
                // 拿到了多少折扣 —— 试算返回的 `discount` 才是实际生效的那个。
                const percent = pricePreview?.discount ?? product.discount;
                const base = pricePreview?.basePrice;
                const showStrike =
                  base != null && pricePreview != null && base > pricePreview.price;
                return (
                  <>
                    {showStrike ? (
                      <span className="text-base text-muted-foreground/60 line-through">
                        {money(base, pricePreview.currency, props.locale)}
                      </span>
                    ) : null}
                    {percent != null && percent > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {tr('product.discount', { percent })}
                      </span>
                    ) : null}
                  </>
                );
              })()}
            </div>
            {pricePreview?.originalTotal !== undefined ? (
              <dl className="hidden text-xs text-muted-foreground lg:block">
                <div className="flex items-baseline justify-between gap-3">
                  <dt>{tr('configure.originalPrice')}</dt>
                  <dd className="text-right tabular-nums">
                    {money(pricePreview.originalTotal, pricePreview.currency, props.locale)}
                  </dd>
                </div>
              </dl>
            ) : null}
            {pricePreview?.renewPrice !== undefined ? (
              <dl className="hidden text-xs text-muted-foreground lg:block">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">{tr('configure.renewalLabel')}</dt>
                  <dd className="text-right">
                    {money(pricePreview.renewPrice * quantity, pricePreview.currency, props.locale)}
                    {checkoutConfig ? (
                      <span className="text-muted-foreground">
                        {' / '}
                        {
                          checkoutConfig.cycles.find((item) => item.id === currentSelection?.cycle)
                            ?.label
                        }
                      </span>
                    ) : null}
                  </dd>
                </div>
              </dl>
            ) : null}
          </div>
          {checkoutConfig && !pricePreview ? (
            <p className="mt-2 hidden text-xs text-muted-foreground lg:block">
              {tr('product.configPriceHint')}
            </p>
          ) : null}
          {pricePreview &&
          (pricePreview.breakdown?.length ||
            pricePreview.summary ||
            (pricePreview.settlementCurrency &&
              pricePreview.settlementCurrency !== product.currency)) ? (
            <div className="hidden lg:block">
              <CheckoutPricePreview
                preview={pricePreview}
                currency={product.currency}
                tr={tr}
                locale={props.locale}
              />
            </div>
          ) : null}
          {product.stock > 0 ? (
            <p className="hidden text-xs text-muted-foreground lg:block">
              {tr('product.stockCount', { count: product.stock })}
            </p>
          ) : null}
          {canBuy && pricePreview ? (
            <form
              action={props.actions['store.add-to-cart']}
              className="flex flex-col gap-2 border-t pt-4"
            >
              <input type="hidden" name="productId" value={product.id} />
              <input type="hidden" name="quantity" value={quantity} />
              {currentSelection ? (
                <input type="hidden" name="config" value={JSON.stringify(currentSelection)} />
              ) : null}
              <Button
                data-quote-purchase="product-selection"
                data-unavailable={!props.actions['store.add-to-cart']}
                type="submit"
                disabled={!props.actions['store.add-to-cart']}
                className="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {tr('product.addToCart')}
              </Button>
            </form>
          ) : (
            <Button disabled variant="outline" className="w-full">
              {!pricePreview
                ? tr('checkout.priceUnavailable')
                : product.stock < quantity
                  ? tr('stock.outOfStock')
                  : tr('product.notPurchasable')}
            </Button>
          )}
        </aside>
      </div>
    </main>
  );
};

function purchaseQuantity(value: unknown): number {
  const number = Number(value || 1);
  return Number.isSafeInteger(number) && number >= 1 && number <= 100 ? number : 1;
}

function cartItemAvailable(item: CartItem): boolean {
  return (
    !item.unavailableReason &&
    item.product.status === 'ACTIVE' &&
    item.product.stock >= item.quantity
  );
}

function StoreCartPage(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const cart = props.data.cart as CartPayload | undefined;
  const methods = props.data.methods as z.infer<typeof paymentMethodsSchema> | undefined;
  const result = props.data.cartOrder as
    | { id: string; status: string; total: number; currency: string; paymentUrl: string | null }
    | null
    | undefined;
  const resultRequested = Boolean(props.searchParams?.orderId);
  const items = cart?.items ?? [];
  const currencies = [...new Set(items.map((item) => item.product.currency))];
  const labels = {
    items: tr('cart.selectItems'),
    total: tr('cart.total'),
    payment: tr('checkout.payment'),
    submit: tr('cart.payNow'),
    unavailable: tr('checkout.methodsUnavailable'),
  };
  return (
    <main className="flex min-w-0 flex-col gap-6 pb-8">
      <PageHeader
        title={tr('cart.title')}
        actions={
          <Button variant="outline" nativeButton={false} render={<Link href="/account/store" />}>
            {tr('cart.backToCatalog')}
          </Button>
        }
      />
      {resultRequested ? (
        <CartCheckout
          lines={[]}
          methods={[]}
          currency={result?.currency ?? 'CNY'}
          locale={props.locale}
          labels={labels}
          resultRequested
          result={result}
        />
      ) : !cart ? (
        <InlineError>{tr('cart.loadFailed')}</InlineError>
      ) : !items.length ? (
        <Empty text={tr('cart.empty')} />
      ) : (
        <>
          {currencies.length > 1 ? (
            <p className="text-sm text-muted-foreground">{tr('cart.separateCurrencies')}</p>
          ) : null}
          {currencies.map((currency) => (
            <CartCheckout
              key={
                currency +
                ':' +
                items.map((item) => item.id + ':' + item.quantity + ':' + item.total).join(',')
              }
              currency={currency}
              locale={props.locale}
              labels={labels}
              wallet={props.actions['store.checkout-wallet']}
              external={props.actions['store.checkout-external']}
              methods={
                methods
                  ? [
                      ...(props.actions['store.checkout-wallet']
                        ? [{ id: 'wallet', label: methods.wallet.label }]
                        : []),
                      ...(props.actions['store.checkout-external']
                        ? methods.providers.flatMap((provider) =>
                            provider.methods.map((method) => ({
                              id: provider.id + ':' + method.id,
                              label: method.label,
                              providerId: provider.id,
                              paymentMethod: method.id,
                            })),
                          )
                        : []),
                    ]
                  : []
              }
              lines={items
                .filter((item) => item.product.currency === currency)
                .map((item) => ({
                  id: item.id,
                  name: item.product.name,
                  quantity: item.quantity,
                  total: item.total,
                  summary: item.summary,
                  available: cartItemAvailable(item),
                  controls: (
                    <>
                      {!cartItemAvailable(item) ? (
                        <p className="basis-full text-xs text-destructive">
                          {item.unavailableReason
                            ? tr(`cart.reason.${item.unavailableReason}`)
                            : tr('cart.unavailable')}
                        </p>
                      ) : null}
                      {props.actions['store.update-cart-item'] ? (
                        <form
                          action={props.actions['store.update-cart-item']}
                          className="flex items-center gap-2"
                        >
                          <input type="hidden" name="id" value={item.id} />
                          <label
                            className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
                            htmlFor={'cart-quantity-' + item.id}
                          >
                            {tr('cart.quantity')}
                          </label>
                          <Input
                            id={'cart-quantity-' + item.id}
                            aria-label={item.product.name + ' ' + tr('cart.quantity')}
                            name="quantity"
                            type="number"
                            min={1}
                            max={Math.max(1, Math.min(100, item.product.stock))}
                            defaultValue={item.quantity}
                            className="w-20"
                          />
                          <Button
                            type="submit"
                            size="sm"
                            variant="outline"
                            disabled={item.product.status !== 'ACTIVE' || item.product.stock < 1}
                          >
                            {tr('cart.update')}
                          </Button>
                        </form>
                      ) : null}
                      {props.actions['store.remove-cart-item'] ? (
                        <form action={props.actions['store.remove-cart-item']} className="ml-auto">
                          <input type="hidden" name="id" value={item.id} />
                          <Button
                            type="submit"
                            size="sm"
                            variant="ghost"
                            aria-label={tr('cart.remove') + ' ' + item.product.name}
                          >
                            <Icon name="trash" />
                            {tr('cart.remove')}
                          </Button>
                        </form>
                      ) : null}
                    </>
                  ),
                }))}
            />
          ))}
        </>
      )}
    </main>
  );
}

function StoreCheckoutPage(_props: AccountPageComponentProps): ReactElement {
  redirect('/account/store/cart');
}

function Quantity({
  tr,
  defaultValue = 1,
  form,
}: {
  tr: ReturnType<typeof t>;
  defaultValue?: number;
  form?: string;
}): ReactElement {
  return (
    <label className="block text-xs text-muted-foreground">
      {tr('cart.quantity')}
      <Input
        form={form}
        name="quantity"
        type="number"
        min="1"
        max="100"
        defaultValue={defaultValue}
        className="mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm"
      />
    </label>
  );
}
function ProductNotFound({ tr }: { tr: ReturnType<typeof t> }): ReactElement {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <p className="bg-linear-to-r from-primary to-primary/40 bg-clip-text font-mono text-5xl font-bold text-transparent">
        404
      </p>
      <p className="mt-4 text-sm text-muted-foreground">{tr('product.notFound')}</p>
      <Link
        href="/account/store"
        className="mt-8 inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-5 text-sm font-semibold text-background shadow-sm transition-opacity hover:opacity-90"
      >
        {tr('product.backToCatalog')}
        <Icon name="arrow" />
      </Link>
    </main>
  );
}
function Empty({ text }: { text: string }): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span className="text-muted-foreground/50">
        <Icon name="package" />
      </span>
      <p className="text-sm font-medium text-muted-foreground">{text}</p>
    </div>
  );
}

function StoreAccountCatalogPage(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const result = props.data.products as z.infer<typeof purchasableProductListSchema> | undefined;
  const categories =
    (props.data.categories as { categories: AccountCategoryNode[] } | undefined)?.categories ?? [];
  const query = props.searchParams ?? {};
  const flatten = (
    nodes: AccountCategoryNode[],
    prefix = '',
  ): Array<{ id: string; name: string; label: string }> =>
    nodes.flatMap((node) => [
      { id: node.id, name: node.name, label: prefix + node.name },
      ...flatten(node.children, prefix + node.name + ' / '),
    ]);
  const categoryOptions = flatten(categories);
  const activeCategory = categoryOptions.find((node) => node.id === query.categoryId);
  const page = result?.page ?? 1;
  const pages = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? 12)));
  const catalogHref = (categoryId = '', nextPage = 1, search = query.q ?? '') => {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (categoryId) params.set('categoryId', categoryId);
    if (nextPage > 1) params.set('page', String(nextPage));
    return `/account/store${params.size ? `?${params}` : ''}`;
  };

  return (
    <main className="flex min-w-0 flex-col gap-5">
      <PageHeader
        title={tr('catalog.title')}
        actions={
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/account/store/cart" />}
          >
            <ShoppingCart data-icon="inline-start" />
            {tr('catalog.cart')}
          </Button>
        }
      />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[10rem_minmax(0,1fr)] lg:gap-6">
        {categoryOptions.length ? (
          <nav aria-label={tr('catalog.categoriesAria')} className="min-w-0 lg:pt-1">
            <p className="mb-3 hidden px-2.5 text-xs font-medium text-muted-foreground lg:block">
              {tr('catalog.categoriesAria')}
            </p>
            <div className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
              {[
                { id: '', name: tr('catalog.allCategories'), label: tr('catalog.allCategories') },
                ...categoryOptions,
              ].map((node) => {
                const active = node.id === (query.categoryId ?? '');
                return (
                  <Button
                    key={node.id}
                    variant={active ? 'secondary' : 'ghost'}
                    nativeButton={false}
                    render={<Link href={catalogHref(node.id)} />}
                    aria-current={active ? 'page' : undefined}
                    title={node.label}
                    className="lg:w-full lg:justify-start"
                  >
                    <span className="truncate">{node.label}</span>
                  </Button>
                );
              })}
            </div>
          </nav>
        ) : null}
        <div className="flex min-w-0 flex-col gap-4 lg:first:col-span-2">
          <form
            key={`${query.categoryId ?? ''}:${query.q ?? ''}`}
            method="get"
            action="/account/store"
            className="flex min-w-0 items-center gap-2"
          >
            {query.categoryId ? (
              <input type="hidden" name="categoryId" value={query.categoryId} />
            ) : null}
            <FieldGroup className="min-w-0 flex-1">
              <Field>
                <label className="sr-only" htmlFor="store-query">
                  {tr('catalog.search')}
                </label>
                <Input
                  id="store-query"
                  name="q"
                  type="search"
                  maxLength={120}
                  placeholder={tr('catalog.search')}
                  defaultValue={query.q ?? ''}
                />
              </Field>
            </FieldGroup>
            <Button type="submit" variant="outline">
              <Search data-icon="inline-start" />
              {tr('catalog.searchAction')}
            </Button>
          </form>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="truncate text-sm font-medium">
                {activeCategory?.name ?? tr('catalog.allServices')}
              </h2>
              {result ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {tr('catalog.resultCount', { count: result.total })}
                </span>
              ) : null}
            </div>
            {query.q || query.categoryId ? (
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link href="/account/store" />}
              >
                {tr('catalog.clearFilters')}
              </Button>
            ) : null}
          </div>
          {!result ? (
            <InlineError>{tr('catalog.loadFailed')}</InlineError>
          ) : !result.products.length ? (
            <Empty text={query.q ? tr('catalog.noResults') : tr('catalog.emptyCategory')} />
          ) : (
            <div className="grid min-w-0 gap-3 min-[560px]:grid-cols-2 xl:grid-cols-3">
              {result.products.map((product) => (
                <Card key={product.id} className="min-w-0">
                  <CardHeader>
                    <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate text-xs text-muted-foreground">
                        {categoryOptions.find((node) => node.id === product.categoryId)?.name ??
                          fulfillmentLabel(product.fulfillmentType, tr)}
                      </span>
                      <StockBadge stock={product.stock} tr={tr} />
                    </div>
                    <CardTitle className="text-sm leading-5">
                      <Link
                        href={`/account/store/${encodeURIComponent(product.id)}`}
                        className="hover:underline underline-offset-4"
                      >
                        {product.name}
                      </Link>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex-1">
                    <CardDescription className="line-clamp-2 leading-5">
                      {product.description}
                    </CardDescription>
                  </CardContent>
                  <CardFooter className="items-end justify-between gap-2">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {product.originalPrice !== null && product.originalPrice > product.price ? (
                        <span className="text-xs text-muted-foreground line-through">
                          {money(product.originalPrice, product.currency, props.locale)}
                        </span>
                      ) : null}
                      <span className="text-lg font-semibold tracking-tight tabular-nums">
                        {product.quoteAvailable === false
                          ? tr('checkout.priceUnavailable')
                          : money(product.price, product.currency, props.locale)}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={<Link href={`/account/store/${encodeURIComponent(product.id)}`} />}
                    >
                      {tr(product.purchasable ? 'catalog.configure' : 'catalog.viewDetails')}
                      <ArrowRight data-icon="inline-end" />
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
          {result && result.total > 0 ? (
            <nav
              aria-label={tr('catalog.pagination')}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <span className="text-xs text-muted-foreground">
                {tr('catalog.pagerSummary', { total: result.total, page, pages })}
              </span>
              {pages > 1 ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    nativeButton={false}
                    render={<Link href={catalogHref(query.categoryId, page - 1)} />}
                  >
                    <ArrowLeft data-icon="inline-start" />
                    {tr('catalog.previous')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= pages}
                    nativeButton={false}
                    render={<Link href={catalogHref(query.categoryId, page + 1)} />}
                  >
                    {tr('catalog.next')}
                    <ArrowRight data-icon="inline-end" />
                  </Button>
                </div>
              ) : null}
            </nav>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function orderLines(order: StoreOrder): StoreOrderLine[] {
  return Array.isArray(order.items?.items) ? order.items.items : [];
}

function orderTimestamp(value: string | undefined, locale: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(locale ?? PACKAGE_FALLBACK_LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function paymentStatusCopy(status: string, tr: ReturnType<typeof t>): string {
  switch (status) {
    case 'SUCCEEDED':
    case 'PAID':
      return tr('paymentStatus.succeeded');
    case 'PENDING':
      return tr('paymentStatus.pending');
    case 'FAILED':
      return tr('paymentStatus.failed');
    case 'CANCELLED':
      return tr('paymentStatus.cancelled');
    case 'EXPIRED':
      return tr('paymentStatus.expired');
    case 'REFUNDED':
      return tr('paymentStatus.refunded');
    default:
      return tr('paymentStatus.unknown');
  }
}

function paymentMethodCopy(method: string | null | undefined, tr: ReturnType<typeof t>): string {
  switch (method) {
    case 'bank_transfer':
      return tr('paymentMethod.bankTransfer');
    case 'qrcode':
      return tr('paymentMethod.qrcode');
    case 'wallet':
      return tr('paymentMethod.wallet');
    case 'alipay':
      return tr('paymentMethod.alipay');
    case 'wechat':
    case 'wxpay':
      return tr('paymentMethod.wechat');
    case 'card':
      return tr('paymentMethod.card');
    case null:
    case undefined:
    case '':
      return tr('orders.notAvailable');
    default:
      return method.replaceAll('_', ' ');
  }
}

function StoreAccountOrdersPage(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const history = props.data.orders as
    { orders: StoreOrder[]; total: number; page: number; pageSize: number } | undefined;
  const orders = history?.orders ?? (Array.isArray(props.data.orders) ? props.data.orders : []);
  const total = history?.total ?? orders.length;
  const page = history?.page ?? 1;
  const pageSize = history?.pageSize ?? 20;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cancel = props.actions?.['store.cancel-order'];
  const refund = props.actions?.['store.request-refund'];
  const pageHref = (next: number) =>
    next > 1 ? `/account/orders?page=${next}` : '/account/orders';
  return (
    <main className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-2">
        <PageHeader
          title={tr('orders.title')}
          actions={
            <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
              {tr('orders.count', { count: total })}
            </span>
          }
        />
        <p className="text-sm text-muted-foreground">{tr('orders.subtitle')}</p>
      </div>
      {orders.length ? (
        <ul className="flex flex-col gap-3">
          {orders.map((order) => {
            const lines = orderLines(order);
            const primary = lines[0];
            const remaining = Math.max(0, lines.length - 1);
            const pending = order.status === 'PENDING';
            return (
              <li
                key={order.id}
                className="rounded-2xl bg-muted/40 p-4 transition-colors hover:bg-muted/60 sm:p-5"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/account/orders/${encodeURIComponent(order.id)}`}
                        className="text-base font-medium break-words hover:underline underline-offset-4"
                      >
                        {primary?.name ?? tr('orders.untitled')}
                      </Link>
                      {remaining > 0 ? (
                        <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">
                          {tr('orders.moreItems', { count: remaining })}
                        </span>
                      ) : null}
                      <OrderStatus status={order.status} tr={tr} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {orderTimestamp(order.createdAt, props.locale)} ·{' '}
                      {tr('orders.number', { number: order.id.slice(-12) })}
                    </p>
                    {primary?.description ? (
                      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                        {primary.description}
                      </p>
                    ) : null}
                    {lines.length ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {tr('orders.lineSummary', {
                          count: lines.length,
                          quantity: lines.reduce((sum, line) => sum + line.quantity, 0),
                        })}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-row items-end justify-between gap-3 sm:flex-col sm:items-end sm:gap-1">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="text-lg font-semibold tabular-nums">
                        {money(order.total, order.currency, props.locale)}
                      </span>
                      {order.settlementCurrency &&
                      order.settlementTotal !== undefined &&
                      order.settlementCurrency !== order.currency ? (
                        <span className="text-xs text-muted-foreground">
                          {tr('orders.settlement', {
                            amount: money(
                              order.settlementTotal,
                              order.settlementCurrency,
                              props.locale,
                            ),
                          })}
                        </span>
                      ) : null}
                    </div>
                    <Link
                      href={`/account/orders/${encodeURIComponent(order.id)}`}
                      className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {tr('orders.viewDetails')}
                      <ArrowRight className="size-3.5" />
                    </Link>
                  </div>
                </div>
                {pending || (refund && ['PAID', 'PARTIALLY_REFUNDED'].includes(order.status)) ? (
                  <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
                    {pending && order.payment?.paymentUrl ? (
                      <a
                        href={order.payment.paymentUrl}
                        className="inline-flex h-9 items-center rounded-xl bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90"
                      >
                        {tr('orders.continuePayment')}
                      </a>
                    ) : null}
                    {pending && cancel ? (
                      <form action={cancel}>
                        <input type="hidden" name="id" value={order.id} />
                        <button
                          type="submit"
                          className="text-sm text-muted-foreground transition-colors hover:text-destructive"
                        >
                          {tr('orders.cancelOrder')}
                        </button>
                      </form>
                    ) : null}
                    {refund && ['PAID', 'PARTIALLY_REFUNDED'].includes(order.status) ? (
                      <form action={refund}>
                        <input type="hidden" name="id" value={order.id} />
                        <button
                          type="submit"
                          className="text-sm text-muted-foreground transition-colors hover:text-destructive"
                        >
                          {tr('orders.requestRefund')}
                        </button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty text={tr('orders.empty')} />
      )}
      {pages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>{tr('catalog.pagerSummary', { total, page, pages })}</span>
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <a
                href={pageHref(page - 1)}
                className="rounded-lg bg-muted px-3 py-1.5 text-foreground transition-colors hover:bg-muted/70"
              >
                {tr('catalog.previous')}
              </a>
            ) : null}
            {page < pages ? (
              <a
                href={pageHref(page + 1)}
                className="rounded-lg bg-muted px-3 py-1.5 text-foreground transition-colors hover:bg-muted/70"
              >
                {tr('catalog.next')}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}

function StoreAccountOrderDetailPage(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const payload = props.data.order as { order: StoreOrderDetail } | null | undefined;
  const order = payload?.order;
  const cancel = props.actions?.['store.cancel-order'];
  const refund = props.actions?.['store.request-refund'];
  if (!order) {
    return (
      <main className="flex min-w-0 flex-col gap-6">
        <PageHeader
          backHref="/account/orders"
          backLabel={tr('orders.title')}
          title={tr('orders.detailTitle')}
        />
        <Empty text={tr('orders.notFound')} />
      </main>
    );
  }
  const lines = orderLines(order);
  const pending = order.status === 'PENDING';
  const paymentUrl = order.paymentUrl ?? order.payment?.paymentUrl ?? null;
  return (
    <main className="flex min-w-0 flex-col gap-6">
      <PageHeader
        backHref="/account/orders"
        backLabel={tr('orders.title')}
        title={tr('orders.detailTitle')}
        actions={<OrderStatus status={order.status} tr={tr} />}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl bg-muted/40 p-5">
            <h2 className="text-sm font-medium">{tr('orders.items')}</h2>
            {lines.length ? (
              <ul className="mt-3 flex flex-col gap-2">
                {lines.map((line, index) => (
                  <li key={`${line.productId}-${index}`} className="rounded-xl bg-background p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium break-words">{line.name}</p>
                        {line.description ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {line.description
                              .split(' · ')
                              .filter(Boolean)
                              .map((part, partIndex) => (
                                <span
                                  key={`${partIndex}-${part}`}
                                  className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                                >
                                  {part}
                                </span>
                              ))}
                          </div>
                        ) : null}
                        <p className="mt-2 text-xs text-muted-foreground">
                          {tr('orders.quantity', { count: line.quantity })} ·{' '}
                          {tr('orders.unitPrice', {
                            amount: money(line.price, line.currency, props.locale),
                          })}
                        </p>
                      </div>
                      <span className="text-sm font-medium tabular-nums">
                        {money(line.price * line.quantity, line.currency, props.locale)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 rounded-xl bg-background p-4 text-sm text-muted-foreground">
                {tr('orders.noItems')}
              </p>
            )}
          </section>
          <section className="rounded-2xl bg-muted/40 p-5">
            <h2 className="text-sm font-medium">{tr('orders.payment')}</h2>
            <dl className="mt-3 flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{tr('orders.paymentMethod')}</dt>
                <dd>{paymentMethodCopy(order.payment?.paymentMethod, tr)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{tr('orders.paymentStatus')}</dt>
                <dd>
                  {order.payment
                    ? paymentStatusCopy(order.payment.status, tr)
                    : tr('orders.notAvailable')}
                </dd>
              </div>
            </dl>
            {order.paymentInstructions?.message ? (
              <div className="mt-3 rounded-xl bg-background p-4">
                <p className="text-xs font-medium text-muted-foreground">
                  {tr('orders.paymentInstructions')}
                </p>
                <p className="mt-2 text-sm whitespace-pre-line">
                  {order.paymentInstructions.message}
                </p>
                {order.paymentInstructions.detail &&
                Object.keys(order.paymentInstructions.detail).length ? (
                  <dl className="mt-3 flex flex-col gap-2 rounded-xl bg-muted/60 p-3 text-sm">
                    {Object.entries(order.paymentInstructions.detail)
                      .filter(([, value]) => value !== null && value !== undefined && value !== '')
                      .map(([label, value]) => (
                        <div key={label} className="flex items-start justify-between gap-3">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="max-w-[65%] break-all text-right font-medium">
                            {typeof value === 'string' || typeof value === 'number'
                              ? String(value)
                              : JSON.stringify(value)}
                          </dd>
                        </div>
                      ))}
                  </dl>
                ) : null}
              </div>
            ) : null}
            {pending && paymentUrl ? (
              <a
                href={paymentUrl}
                className="mt-3 inline-flex h-10 items-center rounded-xl bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90"
              >
                {tr('orders.continuePayment')}
              </a>
            ) : null}
          </section>
        </div>
        <aside className="flex flex-col gap-4">
          <section className="rounded-2xl bg-muted/40 p-5">
            <h2 className="text-sm font-medium">{tr('orders.orderInfo')}</h2>
            <dl className="mt-3 flex flex-col gap-2 text-sm">
              <div className="flex items-start justify-between gap-3">
                <dt className="text-muted-foreground">{tr('orders.orderId')}</dt>
                <dd className="max-w-[60%] break-all text-right font-mono text-xs">{order.id}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{tr('orders.createdAt')}</dt>
                <dd>{orderTimestamp(order.createdAt, props.locale)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{tr('orders.updatedAt')}</dt>
                <dd>{orderTimestamp(order.updatedAt, props.locale)}</dd>
              </div>
            </dl>
          </section>
          <section className="rounded-2xl bg-muted/40 p-5">
            <h2 className="text-sm font-medium">{tr('orders.summary')}</h2>
            <dl className="mt-3 flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{tr('orders.total')}</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {money(order.total, order.currency, props.locale)}
                </dd>
              </div>
              {order.settlementCurrency &&
              (order.settlementCurrency !== order.currency ||
                order.settlementTotal !== order.total) ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{tr('orders.settlementLabel')}</dt>
                  <dd className="tabular-nums">
                    {money(
                      order.settlementTotal ?? order.total,
                      order.settlementCurrency,
                      props.locale,
                    )}
                  </dd>
                </div>
              ) : null}
            </dl>
            {pending && cancel ? (
              <form action={cancel} className="mt-4">
                <input type="hidden" name="id" value={order.id} />
                <button
                  type="submit"
                  className="inline-flex h-10 w-full items-center justify-center rounded-xl bg-background text-sm font-medium text-foreground transition-colors hover:bg-muted hover:text-destructive"
                >
                  {tr('orders.cancelOrder')}
                </button>
              </form>
            ) : null}
            {refund && ['PAID', 'PARTIALLY_REFUNDED'].includes(order.status) ? (
              <form action={refund} className="mt-2">
                <input type="hidden" name="id" value={order.id} />
                <button
                  type="submit"
                  className="inline-flex h-10 w-full items-center justify-center rounded-xl bg-background text-sm font-medium text-foreground transition-colors hover:bg-muted hover:text-destructive"
                >
                  {tr('orders.requestRefund')}
                </button>
              </form>
            ) : null}
          </section>
        </aside>
      </div>
    </main>
  );
}

function ServiceStatusBadge({
  status,
  label,
  tr,
}: {
  status: string;
  label?: string | null | undefined;
  tr: ReturnType<typeof t>;
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
      {label ?? (SERVICE_STATUS_LABELS[status] ? tr(SERVICE_STATUS_LABELS[status]!) : status)}
    </span>
  );
}

/** Service status -> message id. Keys are persisted API values, not copy. */
const SERVICE_STATUS_LABELS: Record<string, string> = {
  AWAITING_UPSTREAM_PAYMENT: 'serviceStatus.upstreamPayment',
  REQUIRES_RECONCILIATION: 'serviceStatus.reconciliation',
  AWAITING_APPROVAL: 'serviceStatus.awaitingApproval',
  ACTIVE: 'serviceStatus.active',
  PENDING_PROVISION: 'serviceStatus.pendingProvision',
  PROVISIONING: 'serviceStatus.provisioning',
  SUSPENDED: 'serviceStatus.suspended',
  TERMINATED: 'serviceStatus.terminated',
  FAILED: 'serviceStatus.failed',
};

type ServiceCardSummary = z.infer<typeof serviceSummarySchema> & {
  metrics?: z.infer<typeof serviceMetricsSchema>['metrics'];
  publicIp?: string;
};

function ServiceUsage({
  tr,
  metrics = [],
  networkOnly = false,
}: {
  tr: ReturnType<typeof t>;
  metrics?: z.infer<typeof serviceMetricsSchema>['metrics'];
  networkOnly?: boolean;
}): ReactElement {
  const latest = (pattern: RegExp) => {
    const series = metrics.find((item) => pattern.test(`${item.id} ${item.label}`));
    const value = series?.points.at(-1)?.v;
    return typeof value === 'number' && Number.isFinite(value)
      ? { value, unit: series!.unit }
      : null;
  };
  const upload = latest(/upload|tx|上行|发送/i);
  const download = latest(/download|rx|下行|接收/i);
  return (
    <div className="flex flex-col gap-3">
      {(!networkOnly
        ? [
            [tr('console.cpuUsage'), latest(/cpu|处理器/i)] as const,
            [tr('console.memoryUsage'), latest(/memory|mem|内存/i)] as const,
          ]
        : []
      ).map(([label, raw]) => {
        const metric = raw as { value: number; unit: string } | null;
        return (
          <div key={label} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-mono">
                {metric ? `${metric.value.toFixed(1)} ${metric.unit}` : '—'}
              </span>
            </div>
            {metric?.unit === '%' && metric.value >= 0 && metric.value <= 100 ? (
              <meter
                className="h-1 w-full"
                min={0}
                max={100}
                value={metric.value}
                aria-label={String(label)}
              />
            ) : (
              <div className="h-1 rounded-full bg-muted" aria-label={`${label} —`} />
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <ArrowUp className="size-3" aria-hidden="true" />
          {tr('console.upload')}{' '}
          <span className="font-mono text-foreground">
            {upload ? `${upload.value.toFixed(1)} ${upload.unit}` : '—'}
          </span>
        </span>
        <span className="inline-flex items-center gap-1">
          <ArrowDown className="size-3" aria-hidden="true" />
          {tr('console.download')}{' '}
          <span className="font-mono text-foreground">
            {download ? `${download.value.toFixed(1)} ${download.unit}` : '—'}
          </span>
        </span>
      </div>
    </div>
  );
}

function ServiceInstanceCard({
  service,
  locale,
  tr,
}: {
  service: ServiceCardSummary;
  locale: string | undefined;
  tr: ReturnType<typeof t>;
}): ReactElement {
  const config = service.configuration ?? [];
  const value = (label: RegExp) => config.find((item) => label.test(item.label))?.value ?? '—';
  const runtime = service.runtime as { ip?: unknown } | null;
  const ip =
    service.publicIp ?? (typeof runtime?.ip === 'string' && runtime.ip.trim() ? runtime.ip : '—');
  return (
    <Card className="h-full min-w-0">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="min-w-0 break-words">
            <Link href={`/account/services/${service.id}`}>
              {serviceInstanceName(service.runtime) ?? service.productName}
            </Link>
          </CardTitle>
          <ServiceStatusBadge status={service.status} tr={tr} />
        </div>
        <div className="mt-2 flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{tr('console.serviceId')}</p>
            <p className="mt-1 truncate font-mono text-xs" title={service.id}>
              {service.id}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={`/account/services/${service.id}`} />}
          >
            {tr('console.manage')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <section
          className="flex flex-col gap-3 border-t pt-4"
          aria-label={tr('console.configuration')}
        >
          <p className="text-sm font-medium">{value(/区域|地区|region|location/i)}</p>
          <dl className="grid grid-cols-3 gap-3">
            {[
              [tr('console.cpu'), value(/^cpu$|处理器/i), Cpu],
              [tr('console.memory'), value(/内存|memory|ram/i), MemoryStick],
              [tr('console.disk'), value(/系统盘|disk|storage/i), HardDrive],
            ].map(([label, val, Icon]) => {
              const ItemIcon = Icon as typeof Cpu;
              return (
                <div key={String(label)} className="min-w-0">
                  <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ItemIcon className="size-3" aria-hidden="true" />
                    {String(label)}
                  </dt>
                  <dd className="mt-1 break-words text-sm font-medium">{String(val)}</dd>
                </div>
              );
            })}
          </dl>
          <div className="flex min-w-0 items-baseline gap-2 text-xs">
            <span className="shrink-0 text-muted-foreground">{tr('console.publicIp')}</span>
            <span className="break-all font-mono">{ip}</span>
          </div>
        </section>
        <section className="border-t pt-4" aria-label={tr('service.metrics')}>
          <ServiceUsage tr={tr} metrics={service.metrics ?? []} />
        </section>
        <dl className="flex flex-col gap-2 border-t pt-4 text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{tr('console.os')}</dt>
            <dd className="min-w-0 break-words text-right">
              {value(/操作系统|镜像|operating.?system|^os$/i)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{tr('console.expires')}</dt>
            <dd className="text-right tabular-nums">{serviceDate(service.expiresAt, locale)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function StoreAccountServicesPage(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const services = (props.data.services as ServiceCardSummary[] | undefined) ?? [];
  return (
    <main className="flex flex-col gap-6">
      <PageHeader title={tr('services.title')} />
      {services.length ? (
        <ul className="grid min-w-0 gap-5 md:grid-cols-2 2xl:grid-cols-3">
          {services.map((service) => (
            <li key={service.id}>
              <ServiceInstanceCard service={service} locale={props.locale} tr={tr} />
            </li>
          ))}
        </ul>
      ) : (
        <Empty text={tr('services.empty')} />
      )}
    </main>
  );
}

function ServiceMetaSheet({
  service,
  name,
  remark,
  action,
  tr,
  trigger,
}: {
  service: z.infer<typeof serviceSchema>['service'];
  name: string;
  remark: string | null;
  action: FrontendActionExecutor;
  tr: ReturnType<typeof t>;
  trigger: ReactElement;
}): ReactElement {
  const formId = `service-meta-${service.id}`;
  return (
    <Sheet>
      <SheetTrigger render={trigger} />
      <SheetContent closeLabel={tr('console.close')} className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{tr('console.editInstance')}</SheetTitle>
          <SheetDescription>{tr('console.editInstanceHint')}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form id={formId} action={action} className="flex flex-col gap-4">
            <input type="hidden" name="id" value={service.id} />
            <Field>
              <label htmlFor={`${formId}-name`} className="text-sm font-medium">
                {tr('console.instanceName')}
              </label>
              <Input
                id={`${formId}-name`}
                name="name"
                defaultValue={name}
                maxLength={64}
                placeholder={tr('console.instanceName')}
              />
            </Field>
            <Field>
              <label htmlFor={`${formId}-remark`} className="text-sm font-medium">
                {tr('console.remark')}
              </label>
              <textarea
                id={`${formId}-remark`}
                name="remark"
                defaultValue={remark ?? ''}
                maxLength={500}
                rows={4}
                placeholder={tr('console.remarkPlaceholder')}
                className="rounded-xl bg-muted/30 px-3 py-2 text-sm"
              />
            </Field>
          </form>
        </SheetBody>
        <SheetFooter>
          <SheetClose
            render={
              <Button type="button" variant="outline">
                {tr('console.cancel')}
              </Button>
            }
          />
          <Button type="submit" form={formId}>
            {tr('console.save')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function ServiceActionSheet({
  action,
  label,
  icon,
  serviceId,
  executor,
  tr,
  trigger,
}: {
  action: z.infer<typeof serviceActionSchema>;
  label: string;
  icon: ReactElement;
  serviceId: string;
  executor: FrontendActionExecutor;
  tr: ReturnType<typeof t>;
  trigger: ReactElement;
}): ReactElement {
  const extraParams = (action.params ?? []).filter(
    (param) => !STATIC_ACTION_FIELDS.has(param.name),
  );
  const formId = `service-action-${action.id}`;
  return (
    <Sheet>
      <SheetTrigger render={trigger} />
      <SheetContent closeLabel={tr('console.close')} className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {icon}
            {label}
          </SheetTitle>
          <SheetDescription>{tr('console.actionHint')}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form id={formId} action={executor} className="flex flex-col gap-4">
            <input type="hidden" name="id" value={serviceId} />
            <input type="hidden" name="actionId" value={action.id} />
            {(action.params ?? [])
              .filter((param) => STATIC_ACTION_FIELDS.has(param.name))
              .map((param) => (
                <Field key={param.name}>
                  <label htmlFor={`${formId}-${param.name}`} className="text-sm font-medium">
                    {param.label}
                    {param.required ? ' *' : ''}
                  </label>
                  {param.type === 'select' ? (
                    <Select
                      id={`${formId}-${param.name}`}
                      name={param.name}
                      required={param.required}
                      defaultValue={param.default != null ? String(param.default) : ''}
                      className="h-10 rounded-xl bg-background px-3 text-sm"
                    >
                      <option value="">{tr('service.selectPlaceholder')}</option>
                      {(param.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  ) : param.type === 'textarea' ? (
                    <textarea
                      id={`${formId}-${param.name}`}
                      name={param.name}
                      required={param.required}
                      defaultValue={param.default != null ? String(param.default) : ''}
                      maxLength={param.maxLength}
                      placeholder={param.placeholder}
                      rows={3}
                      className="rounded-xl bg-background px-3 py-2 text-sm"
                    />
                  ) : (
                    <Input
                      id={`${formId}-${param.name}`}
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
                    />
                  )}
                </Field>
              ))}
            {extraParams.length > 0 ? (
              <Field>
                <label htmlFor={`${formId}-params`} className="text-sm font-medium">
                  {tr('service.extraParams')}
                </label>
                <textarea
                  id={`${formId}-params`}
                  name="params"
                  rows={3}
                  maxLength={4000}
                  placeholder={`{"${extraParams[0]!.name}": "…"}`}
                  className="rounded-xl bg-background px-3 py-2 font-mono text-sm"
                />
                <span className="text-[11px] text-muted-foreground">
                  {tr('service.availableKeys', {
                    keys: extraParams.map((param) => param.name).join(', '),
                  })}
                </span>
              </Field>
            ) : null}
            {action.confirm || action.danger ? (
              <label className="flex items-start gap-2 rounded-xl bg-muted/30 p-3 text-sm">
                <input type="checkbox" required className="mt-0.5 size-4 accent-foreground" />
                <span>{tr('console.confirmOperation', { action: label })}</span>
              </label>
            ) : null}
          </form>
        </SheetBody>
        <SheetFooter>
          <SheetClose
            render={
              <Button type="button" variant="outline">
                {tr('console.cancel')}
              </Button>
            }
          />
          <Button type="submit" form={formId} variant={action.danger ? 'destructive' : 'default'}>
            {tr('console.runAction')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function StoreAccountServiceDetailPage(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const service = props.data.service as z.infer<typeof serviceSchema>['service'] | undefined;
  const refund = props.data.refund as z.infer<typeof refundEligibilitySchema> | undefined;
  const refundAction = props.actions?.['store.request-service-refund'];
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
  const openConsoleAction = props.actions?.['store.open-service-console'];
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
    | { diff: number; currency: string; summary?: string | undefined; selection: Selection }
    | null
    | undefined;
  if (!service) return <Empty text={tr('service.missing')} />;
  const fields = service.detail?.fields ?? [];
  const actions = service.detail?.actions ?? [];
  const renewable = canManageService(service.status);
  const networkFields = fields.filter(
    (field) =>
      !field.secret && /(^ip\b|ip地址|公网|内网|ipv[46]|网关|gateway|netmask)/i.test(field.label),
  );
  const informationFields = fields.filter((field) => !networkFields.includes(field));
  const configuration =
    changeOptions?.config?.options.flatMap((option) => {
      const selected = changeOptions.current?.selections?.[option.id];
      const choice = option.choices?.find((item) => item.id === String(selected));
      return choice ? [{ label: option.label, value: choice.label }] : [];
    }) ?? [];
  const configValue = (pattern: RegExp) =>
    configuration.find((item) => pattern.test(item.label))?.value ?? '—';
  const safeField = (pattern: RegExp) =>
    fields.find((field) => !field.secret && pattern.test(field.label))?.value ?? '—';
  const publicFields = networkFields.filter((field) =>
    /公网|public|^ip$|ipv4|ipv6/i.test(field.label),
  );
  const publicIp = publicFields[0]?.value ?? '—';
  const selectedPanel =
    typeof props.searchParams?.panel === 'string' ? props.searchParams.panel : 'overview';
  const availablePanels = [
    'overview',
    ...(resourceGroups.length ? ['resources'] : []),
    ...(renewable && changeAction && changeOptions?.config ? ['change'] : []),
    ...(renewable && renewAction ? ['renew'] : []),
    // 退款面板只在运营打开了退款政策时出现：没开就是一场空入口。
    ...(refund?.policy.enabled ? ['refund'] : []),
  ];
  const panel = availablePanels.includes(selectedPanel) ? selectedPanel : 'overview';
  const baseHref = `/account/services/${encodeURIComponent(service.id)}`;
  const displayName =
    serviceDisplayName(service.runtime) ?? service.detail?.title ?? service.productName;
  const remark = serviceRemark(service.runtime);
  const expiry = serviceExpiryState(service.expiresAt);
  const rows: Array<{
    key: string;
    label: string;
    value: string;
    mono?: boolean;
    copyable?: boolean;
    editable?: boolean;
    expiry?: boolean;
  }> = [
    {
      key: 'serviceId',
      label: tr('console.serviceId'),
      value: service.id,
      mono: true,
      copyable: true,
    },
    {
      key: 'instanceName',
      label: tr('console.instanceName'),
      value: displayName,
      editable: Boolean(runAction),
    },
    {
      key: 'region',
      label: tr('console.region'),
      value: configValue(/区域|地区|region|location/i),
    },
    {
      key: 'os',
      label: tr('console.os'),
      value: configValue(/操作系统|镜像|operating.?system|^os$/i),
    },
    {
      key: 'created',
      label: tr('console.created'),
      value: serviceDate(service.createdAt, props.locale),
    },
    {
      key: 'provisioned',
      label: tr('console.provisioned'),
      value: serviceDate(service.provisionedAt, props.locale),
    },
    {
      key: 'expires',
      label: tr('console.expires'),
      value: serviceDate(service.expiresAt, props.locale),
      expiry: true,
    },
    ...(service.renewal
      ? [
          {
            key: 'renewalPrice',
            label: tr('console.renewalPrice'),
            value: `${money(service.renewal.price, service.renewal.currency, props.locale)} / ${
              service.renewal.months === 1
                ? tr('console.perMonth')
                : tr('console.months', { months: String(service.renewal.months) })
            }`,
          },
        ]
      : []),
  ];
  const additionalFields = informationFields.filter(
    (field) =>
      !/密码|password|用户名|username|端口|port|^cpu$|内存|memory|磁盘|disk|带宽|bandwidth|操作系统|^os$|地域|区域|region/i.test(
        field.label,
      ),
  );
  const hasMetricData = metrics.some((item) => item.points.length > 0);
  const topActionDefinitions = [
    { key: 'vnc', label: tr('console.vnc'), icon: Monitor, pattern: /vnc|console|控制台|远程/i },
    {
      key: 'start',
      label: tr('console.powerOn'),
      icon: Power,
      pattern: /^(start|boot|power.?on)$|开机/i,
    },
    { key: 'reboot', label: tr('console.reboot'), icon: RotateCw, pattern: /reboot|restart|重启/i },
    {
      key: 'stop',
      label: tr('console.powerOff'),
      icon: Square,
      pattern: /^(stop|shutdown|power.?off)$|关机/i,
    },
  ];
  const topActions = topActionDefinitions.flatMap((definition) => {
    const action = actions.find(
      (item) => definition.pattern.test(item.id) || definition.pattern.test(item.label),
    );
    if (!action || !renewable || !runAction) return [];
    return [{ ...definition, action }];
  });
  const topActionIds = new Set(topActions.map(({ action }) => action.id));
  const maintenanceActions = actions.filter(
    (action) => runAction && !topActionIds.has(action.id) && action.id !== 'vnc',
  );
  const actionLabel = (action: (typeof actions)[number]) =>
    /reinstall|重装/i.test(`${action.id} ${action.label}`)
      ? tr('console.reinstall')
      : /password|密码/i.test(`${action.id} ${action.label}`)
        ? tr('console.resetPassword')
        : /exit.?rescue|退出救援/i.test(`${action.id} ${action.label}`)
          ? tr('console.exitRescue')
          : /rescue|救援/i.test(`${action.id} ${action.label}`)
            ? tr('console.rescue')
            : /hard.?off|强制关机/i.test(`${action.id} ${action.label}`)
              ? tr('console.hardPowerOff')
              : /hard.?reboot|强制重启/i.test(`${action.id} ${action.label}`)
                ? tr('console.hardReboot')
                : action.label;
  const actionIcon = (action: (typeof actions)[number]) =>
    /reinstall|重装/i.test(`${action.id} ${action.label}`)
      ? Wrench
      : /password|密码/i.test(`${action.id} ${action.label}`)
        ? KeyRound
        : Settings2;
  const panelLinks: Array<{ id: string; label: string; icon: typeof Activity; href: string }> = [
    {
      id: 'overview',
      label: tr('console.informationMonitoring'),
      icon: Activity,
      href: baseHref,
    },
    ...(resourceGroups.length
      ? [
          {
            id: 'resources',
            label: tr('console.resources'),
            icon: HardDrive,
            href: `${baseHref}?panel=resources`,
          },
        ]
      : []),
    ...(renewable && changeAction && changeOptions?.config
      ? [
          {
            id: 'change',
            label: tr('console.change'),
            icon: ArrowUpRight,
            href: `${baseHref}?panel=change`,
          },
        ]
      : []),
    ...(renewable && renewAction
      ? [
          {
            id: 'renew',
            label: tr('console.renewal'),
            icon: CalendarDays,
            href: `${baseHref}?panel=renew`,
          },
        ]
      : []),
    ...(refund?.policy.enabled
      ? [
          {
            id: 'refund',
            label: tr('service.refundTitle'),
            icon: Wallet,
            href: `${baseHref}?panel=refund`,
          },
        ]
      : []),
  ];
  const updateAction = props.actions?.['store.update-service-meta'];
  return (
    <main className="flex min-w-0 flex-col gap-5">
      <PageHeader
        backHref="/account/services"
        backLabel={tr('services.title')}
        title={displayName}
      />
      <section
        className="flex flex-col gap-4 rounded-2xl bg-muted/35 p-3.5 sm:flex-row sm:items-start sm:justify-between"
        aria-label={tr('console.management')}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <ServiceStatusBadge
              status={service.detail?.status ?? service.status}
              label={service.detail?.statusLabel}
              tr={tr}
            />
            {expiry?.expired ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">
                <TriangleAlert className="size-3.5" aria-hidden="true" />
                {tr('console.expired')}
              </span>
            ) : expiry ? (
              <span
                className={
                  expiry.soon
                    ? 'inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400'
                    : 'inline-flex items-center gap-1 rounded-full bg-background/60 px-2.5 py-1 text-xs text-muted-foreground'
                }
              >
                <Clock className="size-3.5" aria-hidden="true" />
                {tr('console.expiresIn', { days: String(Math.max(expiry.days, 0)) })}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 items-start gap-1.5">
            <p
              className={
                remark
                  ? 'min-w-0 whitespace-pre-wrap break-words text-sm text-foreground'
                  : 'min-w-0 text-sm text-muted-foreground'
              }
            >
              {remark ?? tr('console.noRemark')}
            </p>
            {updateAction ? (
              <ServiceMetaSheet
                service={service}
                name={displayName}
                remark={remark}
                action={updateAction}
                tr={tr}
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tr('console.editInstance')}
                    title={tr('console.editInstance')}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                }
              />
            ) : null}
          </div>
        </div>
        {topActions.length && runAction ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {topActions.map(({ key, label, icon: Icon, action }) => {
              const dangerous = Boolean(action.danger);
              const needsConfirmation = Boolean(action.confirm || action.danger);
              const executor = key === 'vnc' ? (openConsoleAction ?? runAction) : runAction;
              const button = (
                <Button
                  key={`${key}-button`}
                  type={needsConfirmation ? 'button' : 'submit'}
                  variant={key === 'vnc' ? 'default' : dangerous ? 'destructive' : 'ghost'}
                  size="sm"
                >
                  <Icon data-icon="inline-start" />
                  {label}
                </Button>
              );
              if (!needsConfirmation) {
                return (
                  <form key={key} action={executor}>
                    <input type="hidden" name="id" value={service.id} />
                    <input type="hidden" name="actionId" value={action.id} />
                    {button}
                  </form>
                );
              }
              const formId = `top-service-action-${action.id}`;
              return (
                <Sheet key={key}>
                  <SheetTrigger render={button} />
                  <SheetContent closeLabel={tr('console.close')} className="sm:max-w-md">
                    <SheetHeader>
                      <SheetTitle>{actionLabel(action)}</SheetTitle>
                      <SheetDescription>{tr('console.confirmActionHint')}</SheetDescription>
                    </SheetHeader>
                    <SheetBody>
                      <form id={formId} action={executor} className="flex flex-col gap-4">
                        <input type="hidden" name="id" value={service.id} />
                        <input type="hidden" name="actionId" value={action.id} />
                        <label className="flex items-start gap-2 rounded-xl bg-muted/30 p-3 text-sm">
                          <input
                            type="checkbox"
                            required
                            className="mt-0.5 size-4 accent-foreground"
                          />
                          <span>
                            {tr('console.confirmOperation', { action: actionLabel(action) })}
                          </span>
                        </label>
                      </form>
                    </SheetBody>
                    <SheetFooter>
                      <SheetClose
                        render={
                          <Button type="button" variant="outline">
                            {tr('console.cancel')}
                          </Button>
                        }
                      />
                      <Button
                        type="submit"
                        form={formId}
                        variant={dangerous ? 'destructive' : 'default'}
                      >
                        {actionLabel(action)}
                      </Button>
                    </SheetFooter>
                  </SheetContent>
                </Sheet>
              );
            })}
          </div>
        ) : null}
      </section>
      {panelLinks.length > 1 ? (
        <nav
          aria-label={tr('console.sections')}
          className="flex w-fit max-w-full flex-wrap items-center gap-1 rounded-2xl bg-muted/35 p-1"
        >
          {panelLinks.map(({ id, label, icon: Icon, href }) => (
            <Button
              key={id}
              variant={panel === id ? 'default' : 'ghost'}
              size="sm"
              nativeButton={false}
              render={<Link href={href} aria-current={panel === id ? 'page' : undefined} />}
            >
              <Icon data-icon="inline-start" />
              {label}
            </Button>
          ))}
        </nav>
      ) : null}
      {panel === 'overview' ? (
        <div className="flex min-w-0 flex-col gap-5">
          <div className="grid min-w-0 items-start gap-5 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-5">
              <Card className="min-w-0 border-0">
                <CardHeader>
                  <CardTitle>{tr('console.serverInformation')}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                  <dl className="flex flex-col gap-1">
                    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 rounded-lg bg-muted/25 px-3 py-2.5">
                      <dt className="text-muted-foreground">{tr('console.runningStatus')}</dt>
                      <dd>
                        <ServiceStatusBadge
                          status={service.detail?.status ?? service.status}
                          label={service.detail?.statusLabel}
                          tr={tr}
                        />
                      </dd>
                    </div>
                    {rows.map((row) => (
                      <div
                        key={row.key}
                        className={
                          row.mono
                            ? 'flex flex-col gap-1 rounded-lg bg-muted/25 px-3 py-2.5'
                            : 'grid grid-cols-[7rem_minmax(0,1fr)] gap-3 rounded-lg bg-muted/25 px-3 py-2.5'
                        }
                      >
                        <dt className="text-muted-foreground">{row.label}</dt>
                        <dd
                          className={
                            row.mono
                              ? 'flex min-w-0 flex-wrap items-center gap-1 font-mono text-[11px] leading-5'
                              : 'flex min-w-0 flex-wrap items-center gap-1 text-sm'
                          }
                          title={row.value}
                        >
                          <span className={row.mono ? 'min-w-0 break-all' : 'min-w-0 break-words'}>
                            {row.value}
                          </span>
                          {row.copyable ? (
                            <CopyButton
                              value={row.value}
                              label={tr('console.copy')}
                              copiedLabel={tr('console.copied')}
                            />
                          ) : null}
                          {row.editable && updateAction ? (
                            <ServiceMetaSheet
                              service={service}
                              name={displayName}
                              remark={remark}
                              action={updateAction}
                              tr={tr}
                              trigger={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={tr('console.editInstance')}
                                  title={tr('console.editInstance')}
                                >
                                  <Pencil className="size-3.5" />
                                </Button>
                              }
                            />
                          ) : null}
                          {row.expiry && expiry ? (
                            <span
                              className={
                                expiry.expired
                                  ? 'rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive'
                                  : expiry.soon
                                    ? 'rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400'
                                    : 'rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground'
                              }
                            >
                              {expiry.expired
                                ? tr('console.expired')
                                : tr('console.expiresIn', {
                                    days: String(Math.max(expiry.days, 0)),
                                  })}
                            </span>
                          ) : null}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {(() => {
                    const passwordField = fields.find((field) =>
                      /密码|password/i.test(field.label),
                    );
                    const remoteRows = [
                      {
                        key: 'ip',
                        label: tr('console.publicIp'),
                        value: publicIp,
                        secret: true,
                      },
                      {
                        key: 'username',
                        label: tr('console.remoteUsername'),
                        value: safeField(/用户名|username|login.?user/i),
                        secret: false,
                      },
                      ...(passwordField
                        ? [
                            {
                              key: 'password',
                              label: tr('console.remotePassword'),
                              value: passwordField.value,
                              secret: true,
                            },
                          ]
                        : []),
                      {
                        key: 'port',
                        label: tr('console.remotePort'),
                        value: safeField(/端口|port/i),
                        secret: false,
                      },
                    ].filter((row) => row.value && row.value !== '—');
                    if (!remoteRows.length) return null;
                    return (
                      <section
                        className="flex flex-col gap-2"
                        aria-label={tr('console.remoteConnection')}
                      >
                        <h3 className="px-1 text-sm font-medium">
                          {tr('console.remoteConnection')}
                        </h3>
                        <dl className="flex flex-col gap-1">
                          {remoteRows.map((row) => (
                            <div
                              key={row.key}
                              className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 rounded-lg bg-muted/25 px-3 py-2.5"
                            >
                              <dt className="text-muted-foreground">{row.label}</dt>
                              <dd className="min-w-0 break-all font-mono text-xs leading-5">
                                {row.secret ? (
                                  <SecretValue
                                    value={row.value}
                                    revealLabel={tr('console.show')}
                                    hideLabel={tr('console.hide')}
                                    copyLabel={tr('console.copy')}
                                    copiedLabel={tr('console.copied')}
                                  />
                                ) : (
                                  row.value
                                )}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </section>
                    );
                  })()}
                </CardContent>
              </Card>
              <Card className="min-w-0 border-0">
                <CardHeader>
                  <CardTitle>{tr('console.configuration')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    {(configuration.length
                      ? configuration
                      : [
                          { label: tr('console.cpu'), value: '—' },
                          { label: tr('console.memory'), value: '—' },
                          { label: tr('console.disk'), value: '—' },
                          { label: tr('console.bandwidth'), value: '—' },
                        ]
                    ).map((item) => (
                      <div key={item.label} className="rounded-xl bg-muted/25 px-3 py-3">
                        <dt className="text-xs text-muted-foreground">{item.label}</dt>
                        <dd className="mt-1 break-words font-medium">{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
              {maintenanceActions.length && runAction ? (
                <Card className="min-w-0 border-0">
                  <CardHeader>
                    <CardTitle>{tr('console.systemMaintenance')}</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-2 sm:grid-cols-2">
                    {maintenanceActions.map((action) => {
                      const Icon = actionIcon(action);
                      return (
                        <ServiceActionSheet
                          key={action.id}
                          action={action}
                          label={actionLabel(action)}
                          icon={<Icon className="size-4" aria-hidden="true" />}
                          serviceId={service.id}
                          executor={runAction}
                          tr={tr}
                          trigger={
                            <Button type="button" variant="secondary" className="justify-start">
                              <Icon data-icon="inline-start" />
                              {actionLabel(action)}
                            </Button>
                          }
                        />
                      );
                    })}
                  </CardContent>
                </Card>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <Card id="instance-network" className="min-w-0 border-0">
                <CardHeader>
                  <CardTitle>{tr('console.publicIpList')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {publicFields.length ? (
                    <div className="flex flex-col gap-2">
                      {publicFields.map((field, index) => (
                        <div
                          key={`${field.label}-${index}`}
                          className="flex items-center justify-between gap-3 rounded-xl bg-muted/25 px-4 py-3"
                        >
                          <div className="min-w-0">
                            <SecretValue
                              value={field.value}
                              className="font-mono text-sm"
                              revealLabel={tr('console.show')}
                              hideLabel={tr('console.hide')}
                              copyLabel={tr('console.copy')}
                              copiedLabel={tr('console.copied')}
                            />
                            <p className="mt-1 text-xs text-muted-foreground">
                              {tr('console.ipAddress')}
                            </p>
                          </div>
                          <span className="shrink-0 rounded-full bg-background px-2.5 py-1 text-xs text-muted-foreground">
                            {field.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-xl bg-muted/25 px-4 py-6 text-center text-sm text-muted-foreground">
                      {tr('console.noNetwork')}
                    </p>
                  )}
                </CardContent>
              </Card>
              {additionalFields.length ? (
                <Card className="min-w-0 border-0">
                  <CardHeader>
                    <CardTitle>{tr('console.additionalInformation')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {additionalFields.map((field) => (
                        <div key={field.label} className="rounded-xl bg-muted/25 px-3 py-3">
                          <dt className="text-xs text-muted-foreground">{field.label}</dt>
                          <dd className="mt-1 break-all text-sm">
                            {field.secret ? (
                              <SecretValue
                                value={field.value}
                                revealLabel={tr('console.show')}
                                hideLabel={tr('console.hide')}
                                copyLabel={tr('console.copy')}
                                copiedLabel={tr('console.copied')}
                              />
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
                  </CardContent>
                </Card>
              ) : null}
            </div>
          </div>
          <section
            id="instance-monitoring"
            className="flex min-w-0 flex-col gap-4"
            aria-label={tr('console.realtimeMonitoring')}
          >
            <h2 className="text-lg font-semibold tracking-tight">
              {tr('console.realtimeMonitoring')}
            </h2>
            {hasMetricData ? (
              <MetricsExplorer
                series={metrics}
                locale={props.locale}
                labels={{
                  range: tr('metrics.range'),
                  start: tr('metrics.start'),
                  end: tr('metrics.end'),
                  quick1h: tr('metrics.quick1h'),
                  quick6h: tr('metrics.quick6h'),
                  quick12h: tr('metrics.quick12h'),
                  quick24h: tr('metrics.quick24h'),
                  all: tr('metrics.all'),
                  dataRange: tr('metrics.dataRange'),
                  empty: tr('metrics.empty'),
                  noData: tr('metrics.noData'),
                  points: tr('metrics.points'),
                  latest: tr('metrics.latest'),
                  min: tr('metrics.min'),
                  max: tr('metrics.max'),
                  avg: tr('metrics.avg'),
                  custom: tr('metrics.custom'),
                }}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 rounded-xl bg-muted/25 px-4 py-10 text-center">
                <Activity className="size-5 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm font-medium">{tr('metrics.empty')}</p>
              </div>
            )}
          </section>
        </div>
      ) : null}
      {panel === 'renew' && renewable && renewAction ? (
        <Card className="w-full max-w-2xl border-0 bg-muted/25">
          <CardHeader>
            <CardTitle>{tr('console.renewal')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {service.renewal ? (
              <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-background px-4 py-3">
                <span className="text-sm text-muted-foreground">{tr('console.renewalPrice')}</span>
                <span className="text-lg font-semibold">
                  {money(service.renewal.price, service.renewal.currency, props.locale)}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    /{' '}
                    {service.renewal.months === 1
                      ? tr('console.perMonth')
                      : tr('console.months', { months: String(service.renewal.months) })}
                  </span>
                </span>
              </div>
            ) : null}
            <form action={renewAction} className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <input type="hidden" name="id" value={service.id} />
              <input type="hidden" name="paymentMode" value="wallet" />
              <div className="grid gap-1.5">
                <span className="text-xs text-muted-foreground">{tr('console.expires')}</span>
                <span className="text-sm tabular-nums">
                  {serviceDate(service.expiresAt, props.locale)}
                </span>
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="renew-months" className="text-xs text-muted-foreground">
                  {tr('service.renewMonths')}
                </label>
                <Input
                  id="renew-months"
                  name="months"
                  type="number"
                  min={1}
                  max={120}
                  defaultValue={1}
                  className="w-28"
                />
              </div>
              <Button type="submit">{tr('service.renew')}</Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {panel === 'refund' && refund?.policy.enabled ? (
        <ServiceRefundPanel refund={refund} action={refundAction} locale={props.locale} tr={tr} />
      ) : null}

      {panel === 'change' && renewable && changeAction && changeOptions?.config ? (
        <ServiceChangePanel
          serviceId={service.id}
          currency={service.currency}
          config={changeOptions.config}
          current={changeOptions.current}
          quote={changeQuote ?? null}
          changeAction={changeAction}
          tr={tr}
          locale={props.locale}
        />
      ) : null}

      {panel === 'resources' && resourceGroups.length ? (
        <ServiceResourcesPanel
          serviceId={service.id}
          groups={resourceGroups}
          createAction={renewable ? resourceCreateAction : undefined}
          runAction={renewable ? resourceRunAction : undefined}
          tr={tr}
        />
      ) : null}
    </main>
  );
}

/**
 * 退款面板：显示可退金额与申请入口，并把申请状态（待审 / 已拒 / 已退）说清楚。
 *
 * 金额是服务端算好的（政策 + 未使用时长），前端只负责展示：客户端能改金额的退款
 * 表单等于把定价权交给了浏览器。
 */
function ServiceRefundPanel({
  refund,
  action,
  locale,
  tr,
}: {
  refund: z.infer<typeof refundEligibilitySchema>;
  action: FrontendActionExecutor | undefined;
  locale: string | undefined;
  tr: ReturnType<typeof t>;
}): ReactElement {
  const request = refund.request;
  const inFlight = Boolean(request && ['PENDING', 'PROCESSING', 'FAILED'].includes(request.state));
  return (
    <Card className="w-full max-w-2xl border-0 bg-muted/25">
      <CardHeader>
        <CardTitle>{tr('service.refundTitle')}</CardTitle>
        <CardDescription>{tr('service.refundIntro')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {inFlight && request ? (
          <div className="rounded-xl bg-background px-4 py-3">
            <p className="text-sm font-medium">{tr('service.refundPendingTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{tr('service.refundPendingBody')}</p>
            <p className="mt-2 text-sm tabular-nums">
              {money(request.amount, refund.currency, locale)}
            </p>
          </div>
        ) : null}

        {request?.state === 'REJECTED' ? (
          <div className="rounded-xl bg-background px-4 py-3">
            <p className="text-sm font-medium">{tr('service.refundRejectedTitle')}</p>
            {request.reviewReason ? (
              <p className="mt-1 text-xs text-muted-foreground">{request.reviewReason}</p>
            ) : null}
          </div>
        ) : null}

        {request?.state === 'SUCCEEDED' ? (
          <div className="rounded-xl bg-background px-4 py-3">
            <p className="text-sm font-medium">{tr('service.refundSucceededTitle')}</p>
            <p className="mt-2 text-sm tabular-nums">
              {money(request.amount, refund.currency, locale)}
            </p>
          </div>
        ) : null}

        {refund.eligible && action ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-background px-4 py-3">
              <span className="text-sm text-muted-foreground">{tr('service.refundAmount')}</span>
              <span className="text-lg font-semibold tabular-nums">
                {money(refund.refundableAmount, refund.currency, locale)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {refund.windowEndsAt
                ? tr('service.refundWindow', { date: serviceDate(refund.windowEndsAt, locale) })
                : tr('service.refundForever')}
            </p>
            <form action={action} className="flex flex-col gap-3">
              <input type="hidden" name="id" value={refund.serviceId} />
              <Field>
                <Input
                  name="reason"
                  maxLength={500}
                  aria-label={tr('service.refundReason')}
                  placeholder={tr('service.refundReasonPlaceholder')}
                />
              </Field>
              <Button type="submit" variant="outline" className="self-start">
                {tr('service.refundSubmit')}
              </Button>
            </form>
          </>
        ) : null}

        {!refund.eligible && !inFlight && request?.state !== 'SUCCEEDED' ? (
          <p className="text-sm text-muted-foreground">
            {tr('service.refundNotEligible')}
            {refund.reason ? `：${refund.reason}` : ''}
          </p>
        ) : null}
      </CardContent>
    </Card>
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
  tr,
  locale,
}: {
  serviceId: string;
  currency: string;
  config: CheckoutConfig;
  current: Selection | null;
  quote: {
    diff: number;
    currency: string;
    summary?: string | undefined;
    selection: Selection;
  } | null;
  changeAction: FrontendActionExecutor;
  tr: ReturnType<typeof t>;
  locale: string | undefined;
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
    <section className="flex flex-col gap-4">
      <SectionTitle>{tr('change.title')}</SectionTitle>
      <Card className="border-0 bg-muted/25">
        <CardContent className="flex flex-col gap-4">
          <form
            method="get"
            action={`/account/services/${serviceId}`}
            className="flex flex-col gap-4"
          >
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">{tr('change.cycle')}</label>
              <Select
                name="cycle"
                defaultValue={cycle}
                className="h-10 w-full max-w-sm rounded-xl bg-background px-3 text-sm"
              >
                {config.cycles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </div>
            {groups.map((group) => (
              <fieldset key={group.name || 'default'} className="rounded-2xl bg-background p-4">
                {group.name ? (
                  <legend className="px-1 text-xs font-semibold text-muted-foreground">
                    {group.name}
                  </legend>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  {group.options.map((option) => {
                    const value = sel[option.id];
                    const choices = allowedChoices(option, sel, cycle);
                    if (option.type === 'quantity') {
                      return (
                        <div
                          key={option.id}
                          className={
                            group.options.length === 1
                              ? 'grid gap-1.5 sm:col-span-2'
                              : 'grid gap-1.5'
                          }
                        >
                          <label className="text-xs text-muted-foreground">{option.label}</label>
                          <input
                            name={`cfg_${option.id}`}
                            type="number"
                            min={option.min ?? 0}
                            max={option.max ?? undefined}
                            step={option.step ?? 1}
                            defaultValue={typeof value === 'number' ? value : (option.min ?? 0)}
                            className="h-10 w-full rounded-xl bg-background px-3 text-sm"
                          />
                        </div>
                      );
                    }
                    return (
                      <div
                        key={option.id}
                        className={
                          group.options.length === 1 ? 'grid gap-1.5 sm:col-span-2' : 'grid gap-1.5'
                        }
                      >
                        <label className="text-xs text-muted-foreground">{option.label}</label>
                        <Select
                          name={`cfg_${option.id}`}
                          defaultValue={typeof value === 'string' ? value : (choices[0]?.id ?? '')}
                          className="h-10 w-full rounded-xl bg-background px-3 text-sm"
                        >
                          {choices.map((choice) => (
                            <option key={choice.id} value={choice.id}>
                              {choice.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            ))}
            <Button type="submit" variant="secondary">
              {tr('change.quote')}
            </Button>
          </form>
          {quote ? (
            <form
              action={changeAction}
              className="flex flex-wrap items-center gap-3 rounded-xl bg-background/60 p-3"
            >
              <input type="hidden" name="id" value={serviceId} />
              <input type="hidden" name="paymentMode" value="wallet" />
              <input type="hidden" name="config" value={JSON.stringify(quote.selection)} />
              <span className="text-sm">
                {tr('change.diff')}
                <span className="font-semibold">
                  {money(quote.diff, quote.currency || currency, locale)}
                </span>
                {quote.summary ? (
                  <span className="ml-2 text-xs text-muted-foreground">{quote.summary}</span>
                ) : null}
              </span>
              <Button type="submit">{tr('change.confirm')}</Button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

/** 增值运维面板：按资源种类渲染列表 + 新建 + 行内动作。 */
function ServiceResourcesPanel({
  serviceId,
  groups,
  createAction,
  runAction,
  tr,
}: {
  serviceId: string;
  groups: Array<{
    kind: z.infer<typeof resourceKindSchema>;
    resources: Array<z.infer<typeof resourceListSchema>['resources'][number]>;
  }>;
  createAction?: FrontendActionExecutor | undefined;
  runAction?: FrontendActionExecutor | undefined;
  tr: ReturnType<typeof t>;
}): ReactElement {
  return (
    <section className="space-y-4">
      <SectionTitle>{tr('resources.title')}</SectionTitle>
      {groups.map(({ kind, resources }) => (
        <div key={kind.id} className="space-y-3 rounded-2xl bg-muted/25 p-4">
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
            <p className="text-xs text-muted-foreground">{tr('resources.empty')}</p>
          )}
          {kind.creatable && createAction ? (
            <form action={createAction} className="flex flex-wrap items-end gap-2 border-t pt-3">
              <input type="hidden" name="id" value={serviceId} />
              <input type="hidden" name="kind" value={kind.id} />
              <div className="flex flex-1 flex-col gap-1">
                <label className="text-[11px] text-muted-foreground">
                  {tr('resources.createParams')}
                  {(kind.createParams ?? []).length
                    ? tr('resources.availableKeys', {
                        keys: (kind.createParams ?? []).map((p) => p.name).join(', '),
                      })
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
                {tr('resources.create', { kind: kind.label })}
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

function OrderStatus({ status, tr }: { status: string; tr: ReturnType<typeof t> }): ReactElement {
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
      {ORDER_STATUS_LABELS[status] ? tr(ORDER_STATUS_LABELS[status]!) : status}
    </span>
  );
}

/** Order status -> message id. Keys are persisted API values, not copy. */
const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'orderStatus.pending',
  PAID: 'orderStatus.paid',
  COMPLETED: 'orderStatus.completed',
  CANCELLED: 'orderStatus.cancelled',
  FAILED: 'orderStatus.failed',
  REFUNDED: 'orderStatus.refunded',
  PARTIALLY_REFUNDED: 'orderStatus.partiallyRefunded',
};

function StoreSummaryWidget(_props: AdminWidgetProps): ReactElement {
  const tr = t();
  return (
    <Link
      href="/admin/plugin/store/overview"
      className="backend-widget group flex min-h-24 items-center gap-3 p-4 text-card-foreground transition-colors hover:border-primary/40"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <PackageOpen className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{tr('widget.title')}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{tr('widget.description')}</span>
      </span>
      <ArrowUpRight className="size-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
    </Link>
  );
}

/** 实例页退款资格：政策开关/窗口/金额/已有申请，前端据此决定是否显示入口。 */
const refundEligibilitySchema = z.object({
  serviceId: z.string(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  orderId: z.string().nullable(),
  orderAmount: z.number(),
  refundableAmount: z.number(),
  currency: z.string(),
  windowEndsAt: z.string().nullable(),
  policy: z.object({
    enabled: z.boolean(),
    windowDays: z.number().nullable(),
    amountMode: z.enum(['full', 'prorated']),
    feePercentBps: z.number(),
    suspendOnRequest: z.boolean(),
    terminateOnApprove: z.boolean(),
    oncePerOrder: z.boolean(),
  }),
  request: z
    .object({
      id: z.string(),
      state: z.string(),
      amount: z.number(),
      serviceId: z.string().nullable(),
      reason: z.string().nullable(),
      reviewReason: z.string().nullable(),
    })
    .nullable(),
});

const storeFinders: Record<string, FinderProvider> = {
  'store.settings': {
    handler: async (_input, ctx) =>
      ctx.api.get(
        '/store/admin/settings',
        z.object({
          provisioningMode: z.enum(['manual', 'automatic']),
          refund: z.object({
            enabled: z.boolean(),
            windowDays: z.number().int().nullable(),
            amountMode: z.enum(['full', 'prorated']),
            feePercentBps: z.number().int(),
            suspendOnRequest: z.boolean(),
            terminateOnApprove: z.boolean(),
            oncePerOrder: z.boolean(),
          }),
        }),
      ),
  },
  'store.approvals': {
    handler: async (input, ctx) =>
      ctx.api.get(
        `/store/admin/delivery-tasks?status=attention&page=${Math.max(1, Number((input as { page?: string })?.page) || 1)}`,
        z.object({
          total: z.number(),
          page: z.number(),
          pageSize: z.number(),
          tasks: z.array(
            z.object({
              id: z.string(),
              orderId: z.string(),
              productName: z.string(),
              quantity: z.number(),
              status: z.string(),
              userId: z.string(),
              reason: z.string().nullable(),
              attempts: z.number(),
              upstreamServiceId: z.string().nullable(),
              invoiceId: z.string().nullable(),
              paymentState: z.string().nullable(),
              canResumePayment: z.boolean(),
              // 新增字段必须同步进 schema：zod 会静默剔除未知键，
              // 漏了它前端就拿不到「自动重试用尽」标记，红标永远不显示。
              maxAttempts: z.number(),
              retryExhausted: z.boolean(),
            }),
          ),
        }),
      ),
  },
  'store.refundRequests': {
    handler: async (_input, ctx) =>
      ctx.api.get(
        '/store/admin/refund-requests',
        z.object({
          requests: z.array(
            z.object({
              id: z.string(),
              orderId: z.string(),
              userId: z.string(),
              amount: z.number(),
              currency: z.string(),
              state: z.string(),
              reason: z.string().nullable(),
              failureReason: z.string().nullable(),
              // 实例页发起的退款申请：与订单页手工退款共用队列，但运营需要知道
              // 这台机器已经被停用、以及审核通过后上游停用是否真的落地。
              serviceId: z.string().nullable().optional(),
              suspendApplied: z.boolean().optional(),
              terminateApplied: z.boolean().optional(),
              terminateError: z.string().nullable().optional(),
            }),
          ),
        }),
      ),
  },
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
    handler: async (input, ctx) => {
      const query = new URLSearchParams({
        page: String(input.page ?? 1),
        pageSize: String(input.pageSize ?? 12),
      });
      for (const key of ['categoryId', 'q'] as const) {
        const value = input[key];
        if (typeof value === 'string' && value) query.set(key, value);
      }
      const catalog = await ctx.api.get(
        `/store/account/products?${query.toString()}`,
        purchasableProductListSchema,
      );
      // Reuse the checkout pricing authority, including upstream and group discounts.
      const products = await Promise.all(
        catalog.products.map(async (product) => {
          const config = defaultSelection(readCheckoutConfig(product.metadata));
          const quote = await ctx.api
            .post(
              `/store/products/${encodeURIComponent(product.id)}/price`,
              { quantity: '1', ...(config ? { config: JSON.stringify(config) } : {}) },
              pricePreviewSchema,
            )
            .catch(() => null);
          return {
            ...product,
            price: quote?.price ?? product.price,
            originalPrice: quote
              ? Math.max(quote.originalTotal ?? quote.price, product.originalPrice ?? 0)
              : product.originalPrice,
            quoteAvailable: quote !== null,
          };
        }),
      );
      return { ...catalog, products };
    },
  },
  'store.categories': {
    handler: async (_input, ctx) => ctx.api.get('/categories', categoryListSchema),
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
      const { product } = await ctx.api.get(
        `/store/account/products/${encodeURIComponent(id)}`,
        purchasableProductSchema,
      );
      const config = readCheckoutConfig(product.metadata);
      const rawSelection = selectionFromQuery(query, config) ?? defaultSelection(config);
      const selection =
        config && rawSelection ? reconcileSelection(config, rawSelection) : rawSelection;
      const quantity = purchaseQuantity(query.quantity ?? input.quantity);
      const body: Record<string, string> = {
        quantity: String(quantity),
      };
      if (selection) body.config = JSON.stringify(selection);
      const price = await ctx.api
        .post(`/store/products/${encodeURIComponent(id)}/price`, body, pricePreviewSchema)
        .catch(() => null);
      return price ? { ...price, selection } : null;
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
    handler: async (input, ctx) => {
      const query = (input['$query'] ?? {}) as Record<string, string | string[] | undefined>;
      const page = Math.max(1, Number(Array.isArray(query.page) ? query.page[0] : query.page) || 1);
      const pageSize = 20;
      return ctx.api.get(`/orders?page=${page}&pageSize=${pageSize}`, orderListSchema);
    },
  },
  'store.myOrder': {
    handler: async (input, ctx) => {
      const id = typeof input.id === 'string' ? input.id : '';
      if (!id || id.length > 191) return null;
      return ctx.api.get(`/orders/${encodeURIComponent(id)}`, orderDetailSchema).catch(() => null);
    },
  },
  'store.myServices': {
    handler: async (_input, ctx) => {
      const { services } = await ctx.api.get('/services', serviceListSchema);
      const result: ServiceCardSummary[] = [];
      // Bound upstream fan-out; one provider failing must not hide the user's other instances.
      for (let offset = 0; offset < services.length; offset += 4) {
        result.push(
          ...(await Promise.all(
            services.slice(offset, offset + 4).map(async (service): Promise<ServiceCardSummary> => {
              if (!canManageService(service.status)) return service;
              const id = encodeURIComponent(service.id);
              const [detail, metrics] = await Promise.allSettled([
                ctx.api.get(`/services/${id}`, serviceSchema),
                ctx.api.get(`/services/${id}/metrics`, serviceMetricsSchema),
              ]);
              const publicIp =
                detail.status === 'fulfilled'
                  ? detail.value.service.detail.fields.find(
                      (field) => !field.secret && isPublicIpLabel(field.label),
                    )?.value
                  : undefined;
              return {
                ...service,
                ...(publicIp ? { publicIp } : {}),
                ...(metrics.status === 'fulfilled' ? { metrics: metrics.value.metrics } : {}),
              };
            }),
          )),
        );
      }
      return result;
    },
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
  'store.myServiceRefund': {
    handler: async (input, ctx) =>
      ctx.api.get(
        `/services/${encodeURIComponent(typeof input.id === 'string' ? input.id : '')}/refund-eligibility`,
        refundEligibilitySchema,
      ),
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
  /**
   * 履约可用性诊断：哪些商品当前无法交付、缺哪个提供方插件。
   *
   * 商品能否交付取决于运行期已启用的插件，而不是商品行本身；插件被停用后
   * 商品仍是 ACTIVE。后台需要能直接看到这个问题，而不是等买家下单报错。
   */
  'store.fulfillmentDiagnostics': {
    handler: async (_input, ctx) =>
      ctx.api.get(
        '/store/admin/fulfillment-issues',
        z.object({
          issues: z.array(
            z.object({
              productId: z.string(),
              name: z.string(),
              fulfillmentType: z.string(),
              providerId: z.string().nullable(),
              providerProductId: z.string().nullable(),
              code: z.string(),
              message: z.string(),
              blocking: z.boolean(),
            }),
          ),
          providers: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              fulfillmentTypes: z.array(z.string()),
            }),
          ),
        }),
      ),
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
  'store.cartOrder': {
    handler: async (input, ctx) => {
      const query = (input['$query'] ?? {}) as Record<string, string | undefined>;
      if (!query.orderId || query.orderId.length > 191) return null;
      const result = await ctx.api
        .get(
          `/orders/${encodeURIComponent(query.orderId)}`,
          z.object({
            order: z.object({
              id: z.string(),
              status: z.string(),
              total: z.number(),
              currency: z.string(),
              paymentUrl: z.string().nullable(),
              // Manual payments carry instructions instead of a URL; dropping
              // them leaves a PENDING order with nothing for the buyer to do.
              paymentInstructions: z
                .object({
                  kind: z.string(),
                  message: z.string(),
                  detail: z.record(z.string(), z.unknown()),
                })
                .nullable()
                .optional(),
            }),
          }),
        )
        .catch(() => null);
      return result?.order ?? null;
    },
  },
  'store.viewer': {
    handler: async (_input, ctx) => ({ authenticated: Boolean(ctx.session) }),
  },
};

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  settingsSchema,
  finders: storeFinders,
  pages: [
    { path: '/shop/cart', component: 'legacy-cart' },
    { path: '/shop/:id', component: 'legacy-product' },
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
  ],
  pageComponents: {
    shop: ProductListPage,
    'legacy-cart': () => redirect('/account/store/cart'),
    'legacy-product': () => redirect('/register'),
  },
  ui: {
    actions: [
      {
        id: 'store.add-to-cart',
        // Redirects to the cart/next path.
        silent: true,
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
        // The cart summary updates inline.
        silent: true,
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
        // The cart summary updates inline.
        silent: true,
        method: 'DELETE',
        path: '/cart/items/:id',
        permission: 'store.buy',
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
      {
        id: 'store.checkout-wallet',
        // Redirects to the order result page.
        silent: true,
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
        // Redirects to the external payment page.
        silent: true,
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
        successFeedback: { messageKey: 'feedback.orderCancelled' },
        method: 'POST',
        path: '/orders/:id/cancel',
        permission: 'store.buy',
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
      {
        id: 'store.request-refund',
        successFeedback: { messageKey: 'feedback.refundRequested' },
        method: 'POST',
        path: '/orders/:id/refund-requests',
        permission: 'store.buy',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'reason', type: 'string', maxLength: 191 },
        ],
      },
      {
        // 实例页退款：提交后实例立即停用，管理员审核通过才退余额并终止实例。
        id: 'store.request-service-refund',
        successFeedback: { messageKey: 'feedback.refundRequested' },
        method: 'POST',
        path: '/services/:id/refund-requests',
        permission: 'store.buy',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'reason', type: 'string', maxLength: 500 },
        ],
      },
      {
        id: 'store.service-action',
        // 运维操作（重装/重置密码/开关机）的最终结果只有上游知道，界面不转述上游文案，
        // 统一给一条本地化回执；实际变化由实例详情刷新体现。
        successFeedback: { messageKey: 'feedback.serviceActionSubmitted' },
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
        id: 'store.open-service-console',
        // Console/VNC actions return a one-time URL; open it in the same tab.
        silent: true,
        method: 'POST',
        path: '/services/:id/actions',
        permission: 'store.view',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'actionId', type: 'string', required: true, maxLength: 64 },
        ],
        redirect: { responsePath: 'nextPath', external: true },
      },
      {
        id: 'store.update-service-meta',
        successFeedback: { messageKey: 'feedback.serviceUpdated' },
        method: 'POST',
        path: '/services/:id/meta',
        permission: 'store.view',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          // Empty defaults let the form submit an empty string so the field can
          // be cleared; without them the bridge drops empty optional inputs.
          { name: 'name', type: 'string', default: '', maxLength: 64 },
          { name: 'remark', type: 'string', default: '', maxLength: 500 },
        ],
        // Reload the detail page so the sheet closes and the saved remark renders
        // immediately instead of relying on the router cache invalidating itself.
        redirect: { responsePath: 'nextPath' },
      },
      {
        id: 'store.renew-service-wallet',
        // Redirects after a wallet renewal.
        silent: true,
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
        // 资源创建同样是异步的：新行出现前先给一条回执。
        successFeedback: { messageKey: 'feedback.resourceCreated' },
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
        // 行级操作（解绑 IP、删除快照…）可能没有立即可见的变化，同样需要回执。
        successFeedback: { messageKey: 'feedback.resourceActionSubmitted' },
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
        // Redirects after a wallet upgrade/downgrade.
        silent: true,
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
        successFeedback: { messageKey: 'feedback.serviceTransferred' },
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
        successFeedback: { messageKey: 'feedback.refundProcessed' },
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
        successFeedback: { messageKey: 'feedback.productSaved' },
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
        successFeedback: { messageKey: 'feedback.productSaved' },
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
        path: '/settings',
        component: 'admin/settings',
        permission: 'platform.admin',
        systemSettings: { labelKey: 'settings.store.title', order: 60 },
        data: [{ finder: 'store.settings', as: 'settings' }],
      },
      {
        path: '/approvals',
        component: 'admin/approvals',
        permission: 'store.admin',
        nav: { labelKey: 'settings.store.approvals', groupKey: 'nav.groupStore', order: 25 },
        data: [{ finder: 'store.approvals', as: 'approvals', input: { $query: '1' } }],
      },
      {
        path: '/refunds',
        component: 'admin/refunds',
        permission: 'store.admin',
        nav: { labelKey: 'settings.store.refunds', groupKey: 'nav.groupStore', order: 26 },
        data: [{ finder: 'store.refundRequests', as: 'refunds' }],
      },
      {
        path: '/overview',
        component: 'admin/summary',
        permission: 'store.admin',
        nav: { labelKey: 'nav.overview', groupKey: 'nav.groupStore', order: 0 },
        data: [
          { finder: 'store.adminSummary', as: 'summary' },
          { finder: 'store.productTypes', as: 'productTypes' },
        ],
      },
      {
        path: '/products',
        component: 'admin/overview',
        permission: 'store.admin',
        nav: {
          labelKey: 'nav.products',
          groupKey: 'nav.groupStore',
          order: 10,
          activePaths: ['/products'],
        },
        data: [
          { finder: 'store.adminProducts', as: 'products' },
          { finder: 'store.fulfillmentDiagnostics', as: 'fulfillmentDiagnostics' },
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
        path: '/store',
        component: 'account/store',
        permission: 'store.view',
        nav: { labelKey: 'nav.shop', order: 5, activePaths: ['/store'] },
        data: [
          {
            finder: 'store.accountProducts',
            as: 'products',
            input: { page: 1, pageSize: 12, q: '', categoryId: '' },
          },
          { finder: 'store.categories', as: 'categories' },
        ],
      },
      {
        path: '/store/cart',
        component: 'account/cart',
        permission: 'store.buy',
        data: [
          { finder: 'store.cart', as: 'cart' },
          { finder: 'store.paymentMethods', as: 'methods' },
          { finder: 'store.cartOrder', as: 'cartOrder', input: { $query: '1' } },
        ],
      },
      {
        path: '/store/checkout',
        component: 'account/checkout',
        permission: 'store.buy',
      },
      {
        path: '/store/:id',
        component: 'account/product',
        permission: 'store.view',
        data: [
          { finder: 'store.accountProduct', as: 'product', input: { id: ':id' } },
          {
            finder: 'store.pricePreview',
            as: 'pricePreview',
            input: { id: ':id', $query: '1', quantity: '' },
          },
        ],
      },
      {
        path: '/services',
        component: 'account/services',
        permission: 'store.view',
        nav: { labelKey: 'nav.services', groupKey: 'nav.groupServices', order: 10 },
        data: [{ finder: 'store.myServices', as: 'services' }],
      },
      {
        path: '/orders',
        component: 'account/orders',
        permission: 'store.view',
        nav: { labelKey: 'nav.orders', groupKey: 'nav.groupBilling', order: 20 },
        data: [{ finder: 'store.myOrders', as: 'orders', input: { $query: '1' } }],
      },
      {
        path: '/orders/:id',
        component: 'account/order-detail',
        permission: 'store.view',
        data: [{ finder: 'store.myOrder', as: 'order', input: { id: ':id' } }],
      },
      {
        path: '/services/:id',
        component: 'account/service-detail',
        permission: 'store.view',
        data: [
          { finder: 'store.myService', as: 'service', input: { id: ':id' } },
          { finder: 'store.myServiceRefund', as: 'refund', input: { id: ':id' } },
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
      'account/store': StoreAccountCatalogPage,
      'account/product': (props: AccountPageComponentProps) => (
        <ProductDetailPage {...props} data={{ ...props.data, viewer: { authenticated: true } }} />
      ),
      'account/cart': StoreCartPage,
      'account/checkout': StoreCheckoutPage,
      'account/orders': StoreAccountOrdersPage,
      'account/order-detail': StoreAccountOrderDetailPage,
      'account/services': StoreAccountServicesPage,
      'account/service-detail': StoreAccountServiceDetailPage,
    },
  },
};

export default frontend;
