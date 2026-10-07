/**
 * Type-safe plugin SDK for StackPanel. Pure types + tiny helpers, zero runtime
 * dependencies. Plugins are framework-agnostic: the kernel adapts to Fastify.
 */

import type { CustomModelDefinition } from './models.js';
import type { Readable } from 'node:stream';
import type { AuthService } from './auth.js';
import type { EffectResult, Disposable } from './effect.js';
import type { ExtensionClient, ExtensionTransaction } from './extensions.js';
import type { FxService } from './fx.js';
import type { JobContext } from './jobs.js';
import type { NotificationsService } from './notifications.js';
import type { NotificationView } from './notifications.js';
import type { PaymentService } from './payments.js';
import type { StateService } from './state.js';
import type { WalletService } from './wallet.js';
import type { MediaReferenceService } from './media.js';

/**
 * A permission declared by a plugin. The bare string form (`'store.admin'`) is
 * shorthand for `{ key: 'store.admin' }`; the object form lets a plugin attach a
 * human-readable description surfaced in the admin permission picker.
 */
export interface PluginPermission {
  key: string;
  /** Optional human-readable label shown in the admin UI (defaults to the key). */
  name?: string;
  /** Optional explanation shown next to the permission in the admin UI. */
  description?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Required plugin ids that must be active before this plugin activates. */
  requires?: Array<string | PluginDependency>;
  /** Extension point ids this plugin provides to other plugins. */
  provides?: string[];
  /** Extension points this plugin consumes from other active plugins. */
  consumes?: PluginExtensionConsumer[];
  /** Permissions this plugin declares and may enforce on its routes. */
  permissions?: Array<string | PluginPermission>;
  /** Default permissions granted to built-in roles while the plugin is active. */
  roleTemplates?: PluginRoleTemplate[];
  /**
   * Interface locales this plugin ships messages for (BCP 47 tags, e.g.
   * `zh-CN`). Declares capability only (ADR-0016 §5): installing a plugin that
   * lacks the current locale falls back to the site default, and the admin UI
   * may surface a hint. Omitted or empty means "no bundled messages".
   */
  locales?: string[];
  /**
   * Whether this plugin ships with the kernel distribution. Kernel-derived from
   * the package's `stackpanel.builtin` metadata; plugins never declare it in
   * runtime code (ADR-0008 D9).
   */
  builtin?: boolean;
  /**
   * Operations this plugin exposes on the open `/api/v1` surface. Each entry
   * mirrors one of the plugin's own routes: the kernel derives an authenticated
   * alias that dispatches to the *same* handler with the *same* guard, so the
   * open API is a transport adapter and never a second implementation
   * (ADR-0001). See {@link PluginCapability}.
   */
  capabilities?: PluginCapability[];
  /** Execution boundary. Third-party packages default to isolated. */
  execution?: 'trusted' | 'isolated';
}

/**
 * One plugin operation published to the open platform.
 *
 * The mirroring rule is strict: `route` must name an internal route this plugin
 * already declares, and the public alias inherits that route's `auth` and
 * `permission` unchanged. A capability can therefore never widen access —
 * discovery (`GET /api/v1/capabilities`) and enforcement both derive from the
 * internal guard, so the two can never drift.
 */
export interface PluginCapability {
  /** Stable, globally unique id, e.g. `store.orders.read`. */
  id: string;
  method: HttpMethod;
  /** Internal route this capability mirrors, exactly as declared in `routes`. */
  route: string;
  /** Public path under the versioned namespace, e.g. `/api/v1/store/orders`. */
  path: string;
  /** Neutral English summary for the public OpenAPI doc. */
  summary: string;
  /** Whether the operation changes state (writes require `Idempotency-Key`). */
  mutating?: boolean;
  /**
   * Optional refined scope (`资源:read|write`) to advertise for this capability
   * on the open surface (PLAN-open-platform P1 slice four). When set, a token
   * must carry this scope (or the coarse permission the kernel derives from it)
   * to call the alias. The scope can only narrow access — the internal
   * `route.permission` remains the admission gate.
   */
  scope?: string;
}

export type PluginRoleName = 'ADMIN' | 'USER';

/** A plugin dependency with optional semver range and optional flag. */
export interface PluginDependency {
  id: string;
  range?: string;
  optional?: boolean;
}

/** A declaration that this plugin consumes one extension point from another. */
export interface PluginExtensionConsumer {
  pluginId: string;
  extensionPoint: string;
  optional?: boolean;
}

/** Normalize legacy string dependencies to typed dependency entries. */
export function normalizePluginDependencies(
  requires: Array<string | PluginDependency> | undefined,
): PluginDependency[] {
  return (requires ?? []).map((dependency) =>
    typeof dependency === 'string' ? { id: dependency } : dependency,
  );
}

/** Expand mixed permission declarations into their descriptor form. */
export function normalizePluginPermissions(
  permissions: Array<string | PluginPermission> | undefined,
): PluginPermission[] {
  return (permissions ?? []).map((permission) =>
    typeof permission === 'string' ? { key: permission } : permission,
  );
}

/** A role permission template contributed by an active plugin. */
export interface PluginRoleTemplate {
  role: PluginRoleName;
  permissions: string[];
}

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Server-only, plugin-scoped encrypted secret storage. */
export interface PluginSecrets {
  /** Whether encrypted secret storage is configured for this installation. */
  isAvailable(): boolean;
  /** Read a secret owned by this plugin. Never expose this value to a frontend package. */
  get(key: string): Promise<string | null>;
  /** Create or replace a secret owned by this plugin. */
  set(key: string, value: string): Promise<void>;
  /** Delete a secret owned by this plugin. */
  remove(key: string): Promise<void>;
}

/**
 * Known platform event topics, mapping topic → payload type. The kernel
 * declares its built-in topics by augmenting this interface (declaration
 * merging); plugins and apps do the same for theirs. Topics not listed here
 * remain valid with an `unknown` payload, so the bus never becomes a closed set.
 */
export interface PlatformEvents {
  'plugin.activated': { pluginId: string };
  'plugin.deactivated': { pluginId: string };
  'notification.created': { notification: NotificationView; userId: string };
  'notification.updated': { notification: NotificationView; userId: string };
  'payment.settled': { orderId: string | null; paymentId: string };
  'order.paid': {
    orderId: string;
    channelCode?: string | null;
    status?: string;
    total?: number;
    currency?: string;
  };
  'ticket.created': { ticketId: string; userId: string };
  'ticket.message.added': { ticketId: string; authorId: string };
  'ticket.status.changed': { ticketId: string; status: string };
  /** Waterfall value: per-unit order price a pricing policy may rewrite. */
  'store.order.price': OrderPriceContext;
}

/**
 * Value passed through the `store.order.price` waterfall: an interceptor may
 * rewrite `unit` (the per-unit price in minor units) to apply promotion or
 * pricing policy before an order total is computed.
 */
export interface OrderPriceContext {
  productId: string;
  quantity: number;
  currency: string;
  /** Per-unit price in minor units, after product and group discounts. */
  unit: number;
}

/** Payload type for a topic: the declared type when known, otherwise `unknown`. */
export type EventPayload<K extends string> = K extends keyof PlatformEvents
  ? PlatformEvents[K]
  : unknown;

/**
 * An around-listener over a waterfall. It receives the current value and must
 * either delegate with `next(value)` — possibly after transforming it — or
 * return a value directly to short-circuit the rest of the chain.
 */
export type WaterfallListener<T> = (value: T, next: (value: T) => T) => T;

/** Event bus contract shared by the kernel and plugins. */
export interface EventBus {
  /** Broadcast a fact. Subscribers observe; failures are isolated per listener. */
  publish<K extends string>(topic: K, payload?: EventPayload<K>): void;
  /** Observe a topic. Returns a disposer that removes the listener. */
  subscribe<K extends string>(topic: K, handler: (payload: EventPayload<K>) => void): () => void;
  /**
   * Intercept a topic's waterfall: this is policy, not observation. Listeners
   * run around `next` in registration order, so an interceptor can rewrite the
   * value or stop the chain. Returns a disposer; register inside `ctx.effect`
   * so deactivation unwinds it automatically.
   */
  intercept<T>(topic: string, listener: WaterfallListener<T>): () => void;
  /**
   * Run the synchronous around-pipeline for `topic` and return the final value.
   * Interceptors wrap `next` in registration order; `terminal` produces the
   * value once nothing further delegates. Intended for value transforms (order
   * pricing, payload shaping). Unlike `publish`, this is awaited by the caller
   * and therefore strictly synchronous.
   */
  waterfall<T>(topic: string, value: T, terminal: (value: T) => T): T;
}

/** HTTP method set exposed to plugins. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

/** Auth requirement the kernel applies to a plugin route. */
export type RouteAuth = 'public' | 'user' | 'admin';

/** Framework-agnostic request view handed to plugin route handlers. */
export interface HttpRequest {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  /** Raw request headers; Node semantics (e.g. `set-cookie` may be an array). */
  headers: Record<string, string | string[] | undefined>;
  /** Client address as resolved by the kernel/proxy configuration. */
  ip?: string;
  /** Authenticated user (kernel-injected) when the route requires auth. */
  user?: { id: string; role: string; email?: string };
  /**
   * The opaque session token presented on this request (cookie or Bearer).
   * Present whenever the request was authenticated by a user session, so a
   * logout handler can revoke it via `ctx.auth.revokeSession`.
   */
  sessionToken?: string;
}

/** Framework-agnostic reply view handed to plugin route handlers. */
export interface HttpReply {
  code(status: number): HttpReply;
  send(payload?: unknown): void;
  /** Set a response cookie (implemented by the kernel adapter; login plugins use this). */
  setCookie?(name: string, value: string, options?: Record<string, unknown>): void;
  /** Clear a response cookie. */
  clearCookie?(name: string, options?: Record<string, unknown>): void;
}

export interface RouteHandler {
  (request: HttpRequest, reply: HttpReply): unknown | Promise<unknown>;
}

/** Unparsed request view handed to `kind: 'raw'` route handlers. */
export interface RawHttpRequest {
  method: string;
  /** Original path + query exactly as received. */
  url: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  /** Unparsed request body stream (already ended for bodyless requests). */
  body: Readable;
  ip?: string;
  /** Authenticated user (kernel-injected) when the route requires auth. */
  user?: { id: string; role: string; email?: string };
  /** The opaque session token presented on this request. */
  sessionToken?: string;
  /** Escape hatch: the native Node `IncomingMessage`. */
  raw: unknown;
}

/**
 * Reply view for `kind: 'raw'` routes. The plugin fully owns the response:
 * the kernel does not wrap, compress, or re-send it.
 */
export interface RawHttpReply {
  status(code: number): RawHttpReply;
  header(name: string, value: string | string[]): RawHttpReply;
  write(chunk: string | Uint8Array): boolean;
  end(body?: string | Uint8Array): void;
  /** Take over the socket; the kernel will not send a response. */
  hijack(): void;
  /** Register a callback fired once when the client disconnects. */
  onClientClose(fn: () => void): void;
  /** Escape hatch: the native Node `ServerResponse`. */
  raw: unknown;
}

export type RawRouteHandler = (request: RawHttpRequest, reply: RawHttpReply) => Promise<void>;

/** Per-route CORS policy (overrides the kernel's global CORS for this route). */
export interface CorsPolicy {
  /** Allowed origins; `['*']` allows any. */
  origins: string[];
  methods?: HttpMethod[];
  headers?: string[];
  credentials?: boolean;
  /** Preflight cache lifetime in seconds. */
  maxAge?: number;
}

/** Fields shared by every plugin route. */
export interface PluginRouteBase {
  method: HttpMethod;
  path: string;
  /** Auth requirement applied by the kernel. Default 'public'. */
  auth?: RouteAuth;
  /** Permission required after auth; ADMIN always passes. */
  permission?: string;
  /**
   * Per-route request timeout in ms, enforced for raw streaming routes.
   * `0`/`false` or omitted = no limit (SSE/proxies are never cut short by
   * default). Handler routes are unaffected.
   */
  timeout?: number | false;
  /** Per-route request body limit in bytes (handler routes; raw routes stream unparsed). */
  bodyLimit?: number;
  /** Per-route CORS policy; overrides the kernel global CORS. `false` disables it. */
  cors?: CorsPolicy | false;
}

/** A parsed JSON-style route (the default). */
export interface HandledPluginRoute extends PluginRouteBase {
  kind?: 'handler';
  handler: RouteHandler;
}

/**
 * A raw streaming route. The kernel hands the plugin the native request body
 * stream and response so it can proxy SSE, passthrough arbitrary status codes,
 * and hold long-lived connections.
 */
export interface RawPluginRoute extends PluginRouteBase {
  kind: 'raw';
  handler: RawRouteHandler;
}

/** A route contributed by a plugin. */
export type PluginRoute = HandledPluginRoute | RawPluginRoute;

/** An event listener contributed by a plugin. */
export interface PluginEventListener {
  topic: string;
  handler: (payload: unknown) => void;
}

/** Which surface a navigation item belongs to. */
export type NavSurface = 'public' | 'account' | 'admin';

/** A navigation entry contributed by a plugin to the web shell. */
export interface NavItem {
  surface: NavSurface;
  label: string;
  href: string;
}

/** Reserved extension point identifiers provided by the kernel. */
export const EXTENSION_POINTS = {
  routes: 'routes',
  authProvider: 'auth.provider',
  /** External payment methods that business plugins can offer at checkout. */
  paymentProvider: 'payment.provider',
  /** Synchronous, idempotent settlement handler owned by the commerce plugin. */
  paymentSettlement: 'payment.settlement',
  /** Fulfillment providers that turn a paid product into a deliverable/service. */
  fulfillmentProvider: 'fulfillment.provider',
  /** 商品类型插件：定义类型 + 交付（本平台即上游/占位）。 */
  productType: 'store.productType',
  /** 商业域操作（商品/订单/交付物）：由商业插件实现，内核经此出口。 */
  commerce: 'commerce.operations',
  /** 上游商品数据源：为商品表单提供「可关联的上游商品」。 */
  upstreamProductSource: 'upstream.product.source',
  /** 上游已购服务数据源：为管理端提供「可绑定到账号的上游已购服务」。 */
  upstreamServiceSource: 'upstream.service.source',
  /** External notification channels (email/webhook/push) subscribed to `notification.created`. */
  notificationChannel: 'notification.channel',
  eventListener: 'event.listener',
  webNav: 'web.nav',
  adminDashboard: 'ui.admin.dashboard',
  /**
   * 站点 SEO 输送（ADR-0011）：插件提供实体 URL / 元数据，平台聚合为
   * `/sitemap.xml`、`/robots.txt`、`/feed.xml` 与页面级 metadata。
   */
  seoProvider: 'seo.provider',
} as const;

export type ExtensionPointId = (typeof EXTENSION_POINTS)[keyof typeof EXTENSION_POINTS];

/** A typed extension point: register implementations and let the kernel consume them. */
export interface ExtensionPoint<T> {
  readonly id: string;
  register(implementation: T): () => void;
}

/**
 * Third-party authentication provider (e.g. WowID) registers here. The kernel
 * orchestrates the OAuth dance; providers implement pure exchange logic.
 */
export interface AuthProvider {
  readonly id: string;
  readonly name: string;
  /**
   * Build the browser authorization URL for `state`. Redirect clients that
   * require PKCE receive the generated challenge and nonce from the BFF.
   */
  authorizeUrl?(
    state: string,
    options?: { codeChallenge?: string; nonce?: string },
  ): string | undefined;
  /** Validate an external credential (e.g. an OAuth code) and resolve a local identity. */
  authenticate(credential: unknown): Promise<AuthIdentity | null>;
}

export interface AuthIdentity {
  externalId: string;
  email?: string;
  displayName?: string;
}

/** A payment method an external provider makes available to the storefront. */
export interface PaymentMethod {
  id: string;
  label: string;
  /** Fixed top-up amounts, expressed in minor currency units. */
  topUpAmounts?: number[];
}

/** Input created by a business plugin before an external payment is initiated. */
export interface ExternalPaymentRequest {
  purpose: 'ORDER' | 'TOP_UP';
  merchantOrderNo: string;
  amount: number;
  currency: string;
  method: string;
  subject: string;
  notifyUrl: string;
  returnUrl: string;
  clientIp?: string;
}

/** An external payment session returned by a payment provider. */
export interface ExternalPaymentInitiation {
  externalId: string;
  paymentUrl: string;
  expiresAt?: Date;
}

/** Manual-payment instructions shown to the buyer (bank transfer / QR code). */
export interface ManualPaymentInstructions {
  /** e.g. 'bank_transfer' | 'qrcode' */
  kind: string;
  /** Human-readable steps for the buyer. */
  message: string;
  /** Structured detail (bank account fields, QR image URL, …). */
  detail?: Record<string, unknown>;
}

/** Result of initiating a payment on a provider. */
export type ExternalPaymentInitiationResult =
  ExternalPaymentInitiation | { mode: 'manual'; instructions: ManualPaymentInstructions };

/** Payment provider extension. Provider secrets and protocol details stay behind this boundary. */
export interface PaymentProvider {
  readonly id: string;
  readonly name: string;
  /** 'gateway' calls out to a live channel; 'manual' requires admin confirmation. */
  readonly mode: 'gateway' | 'manual';
  /** Public callback path handled by the provider plugin, for example `/callbacks/epay`. */
  readonly callbackPath: string;
  getMethods(): PaymentMethod[];
  /** Provider-scoped config, e.g. epay merchant keys or manual bank details. */
  createPayment(
    request: ExternalPaymentRequest,
    config?: unknown,
  ): Promise<ExternalPaymentInitiationResult>;
  /** Returns true only when the provider confirms the payment can no longer be completed. */
  closePayment?(request: { merchantOrderNo: string; externalId?: string | null }): Promise<boolean>;
}

/** Verified settlement submitted by an external payment provider. */
export interface PaymentSettlement {
  providerId: string;
  merchantOrderNo: string;
  externalId: string;
  amount: number;
  currency: string;
}

/** Settlement details enriched by the kernel before dispatch to handlers. */
export interface ResolvedPaymentSettlement extends PaymentSettlement {
  paymentId: string;
  purpose: 'ORDER' | 'TOP_UP';
  userId: string;
  orderId: string | null;
}

/**
 * Commerce-owned settlement operation. It must be idempotent and complete
 * before callbacks reply. `release` (optional) restores merchant side-effects
 * (e.g. stock) when the kernel's expiry sweep cancels an ORDER payment.
 */
export interface PaymentSettlementHandler {
  settle(
    payment: ResolvedPaymentSettlement,
  ): Promise<{ applied: boolean; purpose: 'ORDER' | 'TOP_UP' }>;
  release?(payment: ResolvedPaymentSettlement): Promise<{ applied: boolean }>;
}

/** Context passed to lifecycle hooks. */
export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly logger: PluginLogger;
  readonly events: EventBus;
  /**
   * Typed access to this plugin's own declared models. Only kinds listed in
   * `customModels` are reachable; queries run against real indexed columns and
   * never touch another plugin's data.
   */
  readonly extensions: ExtensionClient;
  /**
   * Run `fn` inside a single kernel transaction so extension writes and the
   * wallet/payment effects inside it commit or roll back together. Nested
   * `ctx.tx` calls are rejected.
   */
  tx<T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T>;
  /** Plugin-scoped encrypted secret storage, available only in backend code. */
  readonly secrets: PluginSecrets;
  /** Kernel-owned payment orchestration (records, initiation, settlement, sweep). */
  readonly payments: PaymentService;
  /** Kernel-owned wallet service (accounts + ledger). */
  readonly wallet: WalletService;
  /** Kernel-owned FX service (multi-currency pricing → settlement conversion). */
  readonly fx: FxService;
  /** Kernel-owned auth capabilities (verify password, issue session, permissions). */
  readonly auth: AuthService;
  /** Kernel-owned in-app notification service (create/list/mark-read for users). */
  readonly notifications: NotificationsService;
  /** Register durable references from plugin records to kernel attachments. */
  readonly media: MediaReferenceService;
  /**
   * Kernel-owned shared state for cross-request coordination: counters, TTL
   * keys, and locks (concurrency caps, rate windows, sticky routing, scheduling
   * locks). In-process today; the same contract is Redis-ready.
   */
  readonly state: StateService;
  /**
   * Kernel-owned background jobs: enqueue, schedule and handle named tasks on a
   * single worker pool so recurring work runs once across the cluster (ADR-0013).
   */
  readonly jobs: JobContext;
  /**
   * Run a registration as a reversible effect. Everything registered inside —
   * and any disposer handed to `collect` — is unwound automatically when the
   * plugin deactivates, in reverse order. Prefer this over manual
   * `onDeactivate` cleanup so nothing is left behind on unload.
   */
  effect(fn: (collect: (disposable: Disposable) => void) => EffectResult): Disposable;
  /**
   * Publish a named capability service other plugins can inject. Service names
   * are global: registering one already held by another plugin fails. Returns a
   * disposer; register inside `ctx.effect` so deactivation withdraws the
   * service and no stale provider lingers.
   */
  provide<T>(name: string, implementation: T): () => void;
  /** Resolve a service published by another plugin, or `undefined` if absent. */
  getService<T>(name: string): T | undefined;
  /** Resolve a required service; throws a clear error when it is absent. */
  requireService<T>(name: string): T;
  /** Register an implementation to an extension point; returns an unregister fn. */
  registerExtension<T>(pointId: string, implementation: T): () => void;
  /** Read implementations other plugins registered to an extension point. */
  getExtensions<T>(pointId: string): T[];
  /** Read extension implementations together with their owning plugin id. */
  getExtensionsWithOwner<T>(pointId: string): Array<{ pluginId: string; implementation: T }>;
}

/** A plugin definition. Lifecycle hooks are optional; routes/listeners are declarative. */
export interface PluginDefinition {
  manifest: PluginManifest;
  routes?: PluginRoute[];
  eventListeners?: PluginEventListener[];
  /**
   * Named capability services this plugin requires. Each must be published by
   * another plugin (ordering expressed through `requires`); a missing service
   * fails activation with a clear error instead of a late runtime crash.
   */
  inject?: string[];
  /** Custom models this plugin defines (Halo Extension CR equivalent). */
  customModels?: CustomModelDefinition[];
  onRegister?: (ctx: PluginContext) => void | Promise<void>;
  onActivate?: (ctx: PluginContext) => void | Promise<void>;
  onDeactivate?: (ctx: PluginContext) => void | Promise<void>;
}

/** Type-check a plugin definition literal. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}
