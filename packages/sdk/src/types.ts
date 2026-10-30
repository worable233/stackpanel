import type {
  AdminDashboardWidgetMeta,
  AdminActionDefinition,
  AdminRouteDefinition,
  AccountRouteDefinition,
  AccountWidgetDefinition,
  PluginActionDefinition,
  FrontendManifest,
  FrontendPageManifestEntry,
  FrontendSettingsSchema,
} from './frontend.js';
import type { PluginDependency, PluginExtensionConsumer, PluginRoleTemplate } from './plugin.js';
import type { NotificationView } from './notifications.js';
import type { ProductConfigField } from './fulfillment.js';
import type { UpstreamProductItem } from './upstream.js';

export type Role = 'ADMIN' | 'USER';

export type UserStatus = 'ACTIVE' | 'DISABLED';

/** Core user as returned by the API. */
export interface User {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  /** When email ownership was verified, or `null`. */
  emailVerifiedAt: string | null;
  /**
   * Delivery URL of the account avatar (a kernel media route, carrying a content
   * revision), or `null`/absent when no avatar is set. Optional so a BFF can
   * still parse a reply minted by an API that predates avatars.
   */
  avatarUrl?: string | null;
}

/** Public auth policy for the frontend (register form). */
export interface AuthConfigResponse {
  registrationMethods: Array<'email' | 'phone'>;
  /**
   * Whether self-registration is open at all. `false` means an operator closed
   * the register entry point: the UI hides the link and `POST /register`
   * refuses with `auth.registration_closed`.
   */
  registrationEnabled: boolean;
  emailVerificationSupported: boolean;
  emailVerificationRequired: boolean;
  /**
   * Whether self-service password reset can deliver a code (an
   * `identity.challengeSender` is installed and configured).
   */
  passwordResetSupported: boolean;
  /**
   * The operator requires verified emails, but nothing can deliver a code right
   * now. Registration refuses outright in that state, so a form here could never
   * succeed and the UI must show an explanation instead.
   */
  emailVerificationBlocked: boolean;
  captcha: {
    mode: 'off' | 'optional' | 'required';
    configured: boolean;
    providerIds: string[];
    clientConfig: Record<string, unknown> | null;
    /**
     * Widget config per guarded action, for the actions this deployment does not
     * leave at `off`. Public routes only report the non-`off` actions so an
     * anonymous caller never receives a full policy map.
     */
    actions?:
      | Record<
          string,
          { policy: 'off' | 'optional' | 'required'; clientConfig: Record<string, unknown> | null }
        >
      | undefined;
  };
}

/**
 * External origins a captcha widget needs the page's CSP to allow.
 * Declared by the provider (the kernel knows no vendor), sanitized server-side to
 * absolute `https:` origins, and consumed by the web layer's per-request policy.
 * Always normalised to arrays with defaults so consumers never branch on
 * absence.
 */
export interface CaptchaCspSources {
  script: string[];
  frame: string[];
  connect: string[];
}

/** The two widget protocols a provider may publish. Nothing vendor-specific. */
export type CaptchaWidgetKind = 'script' | 'element';

/**
 * `script`: load `script` once, then call `window[globalFn].render(element, …)`.
 * Covers the whole family of "factory + iframe" widgets (Turnstile, hCaptcha,
 * reCAPTCHA, Friendly Captcha…).
 */
export interface CaptchaScriptWidgetConfig {
  kind: 'script';
  /** Absolute URL of the vendor's loader script. */
  script: string;
  /** Global factory the script installs (e.g. `turnstile`). */
  globalFn: string;
  /** Public site key handed to the factory. Never a secret. */
  siteKey: string;
  /** Action forwarded to the vendor, when it supports one. */
  action?: string;
  theme?: 'auto' | 'light' | 'dark';
  locale?: string;
  /** Extra keys merged verbatim into the render options (vendor-specific). */
  renderOptions?: Record<string, unknown>;
  sources?: { script?: string[]; frame?: string[]; connect?: string[] };
}

/**
 * `element`: create `tag`, set `attributes`, listen for `event`, then read the
 * solution out of `tokenAttribute`. Covers custom-element / proof-of-work
 * widgets that mint their own token in the page (Cap and friends).
 */
export interface CaptchaElementWidgetConfig {
  kind: 'element';
  /** Custom element tag the vendor's script registers. */
  tag: string;
  attributes: Record<string, string>;
  /** Attribute read back after `event` fires to obtain the token. */
  tokenAttribute: string;
  /** Event name signalling a solved challenge. */
  event: string;
  /** Event name signalling an expired or withdrawn token. */
  resetEvent?: string;
  sources?: { script?: string[]; frame?: string[]; connect?: string[] };
}

/**
 * Widget config returned by `CaptchaProvider.clientConfig()`.
 *
 * The discriminator is the whole contract: the host renders these two shapes and
 * nothing else, so a new vendor is a new provider preset rather than a new host
 * component.
 */
export type CaptchaClientConfig = CaptchaScriptWidgetConfig | CaptchaElementWidgetConfig;

/**
 * One entry of `GET /captcha/policy`, the kernel-owned projection of the
 * human-verification capability. Consumed instead of `/auth/config` by any page
 * that is not a login/register flow, so it keeps working when the login plugin
 * is not installed.
 */
export interface CaptchaPolicyResponse {
  action: string | null;
  policy: 'off' | 'optional' | 'required';
  configured: boolean;
  clientConfig: Record<string, unknown> | null;
  sources: CaptchaCspSources;
  /** Only present on the action-less form: every non-`off` guarded action. */
  actions?:
    | Record<
        string,
        {
          policy: 'off' | 'optional' | 'required';
          clientConfig: Record<string, unknown> | null;
          sources: CaptchaCspSources;
        }
      >
    | undefined;
}

export interface AccountMutationResponse {
  ok: true;
}

/** Result of POST /register/send-code. */
export interface SendRegisterCodeResponse {
  sent: boolean;
  email: string;
  expiresAt: string;
  expiresInSeconds: number;
}

/**
 * Response of `POST /password/forgot` (login plugin).
 *
 * Deliberately carries no account hint: the same `{ sent: true }` is returned
 * whether or not the address exists, so the endpoint cannot be used to probe
 * for registered emails.
 */
export interface PasswordResetRequestResponse {
  sent: boolean;
}

/** Response of `POST /password/reset` (login plugin). */
export interface PasswordResetResponse {
  ok: boolean;
}

/** Standard success envelope. */
export interface ApiResponse<T> {
  data: T;
}

/** Liveness probe payload. */
export interface Health {
  status: 'ok';
  uptime: number;
  timestamp: string;
}

/** Readiness probe payload. */
export interface Readiness {
  status: 'ready' | 'degraded';
  database: 'ok' | 'unreachable';
}

/** Standard error envelope. */
export interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string;
}

/** Response of POST /auth/login. */
export interface LoginResponse {
  token: string;
  user: User;
}

/** Response of GET /auth/me for the active session. */
export interface CurrentUserResponse {
  user: User;
}

/** Lightweight session view used by the web BFF / proxy (never 401s). */
export interface SessionInfo {
  id: string;
  role: 'ADMIN' | 'USER';
}

export interface SessionInfoResponse {
  user: SessionInfo | null;
}

/**
 * Bootstrap phase (BOOTSTRAP-R1). Mirrors `@stackpanel/spec`'s
 * `BootstrapPhase`; the SDK stays dependency-free so it is duplicated here and
 * pinned by a contract test in `apps/api/tests/bootstrap-contract.test.ts`.
 */
export type BootstrapPhase =
  | 'needs_infra'
  | 'validating'
  | 'queued'
  | 'migrating'
  | 'migration_failed'
  | 'starting'
  | 'runtime_failed'
  | 'needs_admin'
  | 'complete';

/** Public projection of a bootstrap operation (no credentials, no raw errors). */
export interface BootstrapOperationView {
  id: string;
  configGeneration: number;
  targetVersion: string;
  /** Phase as reported by the API; kept as string for forward compatibility. */
  phase: string;
  failure?: string | undefined;
  diagnosticsRequired?: boolean | undefined;
  createdAt: string;
  updatedAt: string;
}

/** Public first-run setup state (GET /setup/status). */
export interface SetupStatusResponse {
  /**
   * Compatibility projection: true when the wizard has work for the operator
   * (infrastructure, a running operation, or the first admin).
   */
  required: boolean;
  /** True when completion requires the operator-configured claim token. */
  tokenRequired: boolean;
  /**
   * Authoritative bootstrap phase (BOOTSTRAP-R1). Both the provision app and
   * the normal app answer this same endpoint with the same shape, so the page
   * can branch without probing a second URL.
   */
  phase: BootstrapPhase;
  /** The current (or most recent) bootstrap operation, when one exists. */
  operation?: BootstrapOperationView | undefined;
}

/** Input to POST /setup — claims an uninitialized instance. */
export interface CompleteSetupInput {
  email: string;
  password: string;
  /** Required only when GET /setup/status reports `tokenRequired`. */
  setupToken?: string;
}

/** A non-secret third-party identity bound to the current account. */
export interface ConnectedIdentity {
  id: string;
  providerId: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
}

export interface ConnectedIdentityListResponse {
  identities: ConnectedIdentity[];
}

/** A permission group membership as returned on an admin-list user. */
export interface UserGroupMembership {
  id: string;
  name: string;
}

/** Admin-list user as returned by GET /admin/users. */
export interface AdminUser {
  id: string;
  email: string;
  groups: UserGroupMembership[];
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  /** Derived avatar URL (kernel media content route), or null when unset. */
  avatarUrl?: string | null | undefined;
  /** Spendable wallet balance in the currency's minor unit. */
  balance?: number | undefined;
  balanceCurrency?: string | undefined;
  /** Number of non-terminated cloud products currently held by the user. */
  serviceCount?: number | null | undefined;
}

/** Response of GET /admin/users (paginated list). */
export interface UserListResponse {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

/** A user's purchased/gifted service as returned by admin endpoints. */
export interface AdminServiceItem {
  id: string;
  productName: string;
  fulfillmentType: string;
  status: string;
  amount: number;
  currency: string;
  expiresAt: string | null;
  providerId: string | null;
  providerServiceId: string | null;
  orderId: string | null;
  createdAt: string;
}

/** One order row shown on the admin user detail page. */
export interface AdminUserOrderItem {
  id: string;
  status: string;
  total: number;
  currency: string;
  createdAt: string;
}

/** One wallet ledger row shown on the admin user detail page. */
export interface AdminUserLedgerItem {
  id: string;
  amount: number;
  currency: string;
  type: string;
  note: string | null;
  createdAt: string;
}

/** Response of GET /admin/users/:id (full user detail aggregate). */
export interface AdminUserDetailResponse {
  user: AdminUser;
  wallet: { balance: number; currency: string } | null;
  services: AdminServiceItem[];
  orders: AdminUserOrderItem[];
  ordersPagination?: { page: number; pageSize: number; total: number } | undefined;
  ledger: AdminUserLedgerItem[];
}

/** Result of POST /admin/users (created user, without group memberships). */
export interface AdminUserCreateResult {
  id: string;
  email: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

/** Response of POST /admin/users. */
export interface AdminUserCreateResponse {
  user: AdminUserCreateResult;
  /** Present only when the server generated a password (none was supplied). */
  generatedPassword?: string | undefined;
}

/** Response of PATCH /admin/users/:id. */
export interface AdminUserMutationResponse {
  user: AdminUser;
}

/** Response of GET /admin/users/:id/services. */
export interface AdminUserServicesResponse {
  services: AdminServiceItem[];
}

/** Response of POST /admin/users/:id/services/:serviceId (PATCH mutation). */
export interface AdminServiceMutationResponse {
  service: AdminServiceItem;
}

/** Response of POST /admin/users/:id/wallet. */
export interface WalletAdjustResponse {
  balance: number;
  currency: string;
}

/** Response of POST /admin/users/:id/impersonate. */
export interface ImpersonateResponse {
  token: string;
}

/** A product row for admin pickers (gifting services). */
export interface AdminProductItem {
  id: string;
  name: string;
  price: number;
  currency: string;
  fulfillmentType: string;
  status: string;
}

/** Response of GET /admin/products. */
export interface AdminProductsResponse {
  products: AdminProductItem[];
}

/** A registered product type (for the store product form). */
export interface StoreProductTypeInfo {
  id: string;
  label: string;
  pluginId: string;
  configFields: ProductConfigField[];
}

/** Response of GET /store/product-types. */
export interface StoreProductTypeListResponse {
  types: StoreProductTypeInfo[];
}

/** A registered upstream product source. */
export interface UpstreamSourceInfo {
  id: string;
  name: string;
}

/** Response of GET /store/upstream-sources. */
export interface UpstreamSourceListResponse {
  sources: UpstreamSourceInfo[];
}

/** Response of GET /store/upstream-products (search). */
export interface UpstreamProductsResponse {
  items: UpstreamProductItem[];
}

/** Response of GET /store/upstream-products/:provider/:productId. */
export interface UpstreamProductResponse {
  item: UpstreamProductItem | null;
}

/** One upstream already-purchased service shown in the admin bind dialog. */
export interface AdminUpstreamServiceItem {
  sourceRef?: string | null | undefined;
  productId?: string | null | undefined;
  id: string;
  name: string;
  productName: string | null;
  status: string | null;
  statusLabel: string | null;
  host: string | null;
  expiresAt: string | null;
  amount: number | null;
  currency: string | null;
  sourceId: string;
  /** Local service id when this upstream service is already bound to this user. */
  boundServiceId: string | null;
  /** User id when this upstream service is bound to a different account. */
  boundUserId: string | null;
}

/** Response of GET /admin/users/:id/upstream-services. */
export interface AdminUserUpstreamServicesResponse {
  sources: UpstreamSourceInfo[];
  services: AdminUpstreamServiceItem[];
}

/** Append-only security and operations audit entry. */
export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  ip: string | null;
  userAgent: string | null;
  meta: unknown;
  createdAt: string;
}

/** Response of GET /admin/audit-log (paginated). */
export interface AuditLogResponse {
  logs: AuditLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** Response of GET /notifications (paginated in-app inbox). */
export interface NotificationListResponse {
  items: NotificationView[];
  unreadCount: number;
  nextCursor: string | null;
}

/** Response of GET /notifications/unread-count. */
export interface NotificationUnreadCountResponse {
  unreadCount: number;
}

/** Response of POST /notifications/read-all. */
export interface NotificationMarkAllResponse {
  count: number;
}

/** A platform API token as returned by the management endpoints (never the secret). */
export interface ApiTokenView {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  ipAllowlist: string[];
  status: string;
  /** 登记后该凭证每个请求都必须带 Ed25519 请求签名（对标 #12.6）。 */
  publicKey?: string | null | undefined;
  signingEnabled?: boolean | undefined;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
}

/** 一条逐页 SEO 覆写（对标 #12.4）。字段为空表示「不干预」，沿用 provider 的值。 */
export interface SeoPageView {
  id: string;
  path: string;
  title: string | null;
  description: string | null;
  ogImage: string | null;
  canonical: string | null;
  noindex: boolean;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SeoPageListResponse {
  pages: SeoPageView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SeoPageUpsertInput {
  path: string;
  title?: string | null;
  description?: string | null;
  ogImage?: string | null;
  canonical?: string | null;
  noindex?: boolean;
}

/**
 * 页面元数据的四层来源（由粗到细）：平台默认 → 主题/插件静态声明 →
 * 插件 `seo.provider` 实体 → 后台逐页覆写。本表只承载最后一层。
 */
export interface SeoPageUpsertResponse {
  page: SeoPageView;
}

/** Response of GET /me/api-tokens. */
export interface ApiTokenListResponse {
  tokens: ApiTokenView[];
}

/** A grantable scope with its display name. */
export interface ApiTokenScope {
  key: string;
  name: string;
}

/** Response of GET /me/api-tokens/scopes. */
export interface ApiTokenScopesResponse {
  prefix: string;
  scopes: ApiTokenScope[];
}

/** Response of POST /me/api-tokens (plaintext returned exactly once). */
export interface ApiTokenCreateResponse {
  token: string;
  apiToken: ApiTokenView;
}

/** Response of PATCH /me/api-tokens/:id. */
export interface ApiTokenUpdateResponse {
  apiToken: ApiTokenView;
}

/** Response of GET /auth/oauth/:providerId/authorize. */
export interface OAuthAuthorizeResponse {
  authorizeUrl: string;
  state: string;
}

/** A non-secret third-party sign-in provider currently available to the browser. */
export interface OAuthProviderInfo {
  id: string;
  name: string;
}

export interface OAuthProviderListResponse {
  providers: OAuthProviderInfo[];
}

/** A navigation entry contributed by a plugin to the web shell. */
export interface NavItem {
  surface: 'public' | 'account' | 'admin';
  label: string;
  href: string;
}

/** Response of GET /nav/:surface. */
export interface NavListResponse {
  items: NavItem[];
}

/**
 * 后台菜单编辑视图（对标 #12.3）：多出「这条来自哪里」的信息。
 * `custom` 是运营自己加的链接，`overrideId` 为 null 表示完全沿用默认。
 */
export interface AdminNavItemView extends NavItem {
  custom: boolean;
  hidden: boolean;
  overrideId: string | null;
  defaultLabel: string | null;
}

export interface AdminNavResponse {
  surface: 'public' | 'account' | 'admin';
  items: AdminNavItemView[];
}

/** 保存排布时的单条输入；label 留空表示沿用默认文案。 */
export interface AdminNavLayoutItemInput {
  href: string;
  label?: string | null | undefined;
  hidden?: boolean | undefined;
}

export interface AdminNavCustomEntry {
  id: string;
  surface: string;
  href: string;
  label: string | null;
  sortOrder: number | null;
  hidden: boolean;
  custom: boolean;
  updatedAt: string;
}

export interface AdminNavCustomResponse {
  entry: AdminNavCustomEntry;
  items: AdminNavItemView[];
}

/** An installed theme. */
export interface ThemeInfo {
  id: string;
  name: string;
  version: string;
  active: boolean;
  /** Interface locales this theme ships messages for (ADR-0016 §5). */
  locales: string[];
  /** Brand assets declared by the theme, exposed as API-relative URLs. */
  assets: {
    logo: string | null;
    favicon: string | null;
  } | null;
}

/** Response of GET /themes. */
export interface ThemesResponse {
  themes: ThemeInfo[];
}

/** Response of GET /themes/active. */
export interface ActiveThemeResponse {
  theme: ThemeInfo | null;
}

/** A theme row as returned by the admin endpoints. */
export interface AdminTheme extends ThemeInfo {
  isDefault: boolean;
  installedAt: string;
  updatedAt: string;
  frontend: FrontendSummary;
  signed: boolean;
}

/** Response of GET /admin/themes. */
export interface AdminThemesResponse {
  themes: AdminTheme[];
}

/** Response of PATCH /admin/themes/:id. */
export interface ThemePatchResponse {
  theme: ThemeInfo;
}

/** A plugin as returned by the admin plugins API. */
export interface PluginDependencyStatus {
  id: string;
  range: string | null;
  optional: boolean;
  installed: boolean;
  version: string | null;
  satisfied: boolean;
}

/** Extension-point consumption status for an active target plugin. */
export interface PluginConsumesStatus {
  pluginId: string;
  extensionPoint: string;
  optional: boolean;
  satisfied: boolean;
}

/** A plugin as returned by the admin plugins API. */
export interface AdminPlugin {
  id: string;
  name: string;
  description: string | null;
  version: string;
  state: string;
  enabled: boolean;
  source: 'builtin' | 'dynamic';
  /** Whether an operator may uninstall this plugin (kernel policy, not provenance). */
  removable: boolean;
  hotReload: boolean;
  frontend: FrontendSummary;
  requires: PluginDependency[];
  dependencies: PluginDependencyStatus[];
  provides: string[];
  consumes: PluginExtensionConsumer[];
  consumesStatus: PluginConsumesStatus[];
  permissions: string[];
  roleTemplates: PluginRoleTemplate[];
  /** Interface locales this plugin ships messages for (ADR-0016 §5). */
  locales: string[];
  signed: boolean;
}

/** Frontend runtime events recorded through the audit API. */
export type FrontendAuditAction =
  | 'frontend.finder.call'
  | 'frontend.admin.route.render'
  | 'frontend.account.route.render'
  | 'frontend.action.execute';

/** Summary of a theme/plugin frontend package for admin lists. */
export interface FrontendSummary {
  available: boolean;
  pages: FrontendPageManifestEntry[];
  finders: string[];
  adminRoutes: AdminRouteDefinition[];
  adminActions: AdminActionDefinition[];
  actions: PluginActionDefinition[];
  accountRoutes: AccountRouteDefinition[];
  accountWidgets: AccountWidgetDefinition[];
  revision: string | null;
  settingsSchema: FrontendSettingsSchema | null;
  /** Interface locales this package ships messages for (ADR-0016 §5). */
  locales: string[];
}

/** Admin action contributed by an active plugin frontend package. */
export interface AdminAction extends AdminActionDefinition {
  pluginId: string;
}

/** Response of GET /admin/ui/actions. */
export interface AdminActionsResponse {
  actions: AdminAction[];
}

/** Response of GET /admin/themes/preview. */
export interface ThemePreviewResponse {
  themeId: string | null;
}

/** Response of theme preview mutations. */
export interface ThemePreviewMutationResponse {
  themeId: string;
}

/** A compiled frontend package contributed by an active plugin. */
export interface PluginFrontendDescriptor {
  id: string;
  manifest: FrontendManifest;
  /**
   * Whether the package is a kernel built-in (trusted). Derived by the kernel
   * from the package's `stackpanel.builtin` metadata — the SAME source the
   * backend `execution` decision uses (plugins.ts loadPluginDefinition).
   */
  builtin: boolean;
  /**
   * The backend execution mode this plugin runs under, mirroring
   * `plugins.ts` `loadPluginDefinition`: built-in → `trusted`, otherwise
   * `isolated` in production. Whether the plugin is admitted to execute in the
   * web process is decided by `serverExecution`, NOT by this field.
   */
  execution: 'trusted' | 'isolated';
  /**
   * Kernel-computed admission decision for server-side execution in the web
   * process (contract 03 §3.1): `allowed` = built-in OR explicitly authorized
   * (`frontendExecutions: 'server'`); `declarative` = not admitted (default).
   */
  serverExecution: 'allowed' | 'declarative';
  /**
   * Active content-addressed revision (contract 04 §1). Present when the kernel
   * has published the plugin frontend to the immutable revision store.
   */
  revision?: string;
}

/** Response of GET /plugins/frontends. */
export interface PluginFrontendsResponse {
  plugins: PluginFrontendDescriptor[];
}

/** Response of GET /permissions/check. */
export interface PermissionCheckResponse {
  allowed: boolean;
}

/**
 * A plugin row that survived its package.
 *
 * Uninstalling a plugin is normally what deletes its database row, so a plugin
 * whose directory was removed by hand (or by a failed upgrade) leaves a record
 * behind: the runtime no longer knows it, `/admin/plugins` cannot list it, and
 * the operator still sees its capabilities "installed" in the database. Surfacing
 * these is what turns "the provider plugin is disabled" into an actionable
 * cleanup.
 */
export interface StalePluginRecord {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  installedAt: string;
}

/** Response of GET /admin/plugins. */
export interface AdminPluginsResponse {
  plugins: AdminPlugin[];
  /** Records left behind after the package directory disappeared. */
  stale: StalePluginRecord[];
}

/** Update channel. */
export type UpdateChannel = 'stable' | 'beta';

/** Update strategy (GET /admin/updates/status · PUT /admin/updates/policy). */
export interface UpdatePolicyView {
  autoUpdate: boolean;
  channel: UpdateChannel;
  autoUpdateKernel: boolean;
  excluded: string[];
  pinned: Record<string, string>;
  maintenanceWindow?: { startHour: number; endHour: number };
  allowPermissionIncrease: boolean;
  allowIrreversibleMigration: boolean;
  updatedAt?: string;
  updatedBy?: string | null;
}

/**
 * `PUT /admin/updates/policy` 的请求体。
 *
 * 未给出的字段保持原值；`maintenanceWindow: null` 表示清除窗口限制（否则设过就关不掉）。
 */
export type UpdatePolicyPatch = Omit<Partial<UpdatePolicyView>, 'maintenanceWindow'> & {
  maintenanceWindow?: { startHour: number; endHour: number } | null;
};

/** Block reason returned when a deployment plan cannot be solved. */
export interface UpdateBlockReason {
  code: string;
  detail: string;
  component?: { kind: string; id: string };
}

/**
 * 目录运行时状态（`GET /admin/updates/status`）。
 *
 * 旧契约只有一个 `catalogConfigured: boolean`，把「显式关闭 / 还没取到 / 取到了 /
 * 取失败」四种情况塔缩成一个布尔值，前端只能把失败说成「未配置」。
 */
export type UpdateCatalogState = 'unconfigured' | 'pending' | 'ready' | 'failed';

/** 目录检查/验签失败原因（含建议重试时间）。 */
export interface UpdateCatalogFailure {
  kind: string;
  message: string;
  retryAt: string | null;
}

/** 目录快照的只读投影；**发网络请求**是单独的显式动作（`checkUpdateCatalog`）。 */
export interface UpdateCatalogView {
  state: UpdateCatalogState;
  repository: string | null;
  channel: UpdateChannel | null;
  sequence: number | null;
  generatedAt: string | null;
  expired: boolean | null;
  failure: UpdateCatalogFailure | null;
  /** 最近一次真的发起过检查的时间（ISO）；从未检查为 null。 */
  lastCheckedAt: string | null;
  /** 手动检查的剩余冷却（毫秒）；0 表示可立即检查。 */
  cooldownMs: number;
}

/** One planned component upgrade. */
export interface UpdatePlannedPackage {
  kind: 'plugin' | 'theme';
  id: string;
  fromVersion: string | null;
  toVersion: string;
  revision: string;
  addsPermissions: boolean;
  reversible: boolean;
}

/** 一个已完成阶段的凭据（升级协议 `UpdateCheckpoint` 的投影）。 */
export interface UpdateCheckpointView {
  phase: string;
  at: string;
  inputDigest: string;
  credential?: string;
}

/** 失败后的恢复结果。 */
export interface UpdateRecoveryView {
  recovered: boolean;
  backupRef?: string;
  detail: string;
}

/**
 * 升级任务结果投影。
 *
 * 旧 schema 只透出 `phase`，把 `checkpoints` / `recovery` / `block` 全部丢掉，
 * 于是「任务失败在哪一步、恢复了没有」在后台完全不可见。
 */
export interface UpdateTaskResultView {
  phase: string;
  checkpoints?: UpdateCheckpointView[];
  block?: UpdateBlockReason;
  recovery?: UpdateRecoveryView;
}

/** Updater status projection (GET /admin/updates/status). */
export interface UpdateUpdaterStatus {
  generation: number;
  digest: string | null;
  activeTask: string | null;
  recent: Array<{ idempotencyKey: string; result: UpdateTaskResultView }>;
  updatedAt: string;
}

export interface UpdateStatusResponse {
  status: UpdateUpdaterStatus | null;
  policy: UpdatePolicyView;
  /** 目录状态（四态）；`ready` 只说明有快照，新鲜度看 `catalogExpired`。 */
  catalogState: UpdateCatalogState;
  catalogConfigured: boolean;
  catalogExpired: boolean | null;
  catalogFailure: UpdateCatalogFailure | null;
  catalogRepository: string | null;
  catalogChannel: UpdateChannel | null;
  catalogSequence: number | null;
  catalogGeneratedAt: string | null;
  lastCheckedAt: string | null;
  cooldownMs: number;
  /** 升级载体（`oci` / `artifact`）。 */
  carrier: string;
  instanceId: string;
}

export interface UpdatePlanResponse {
  ok: boolean;
  blocks?: UpdateBlockReason[];
  /** 目录快照已过期：可展示可求解，但投递需显式覆盖。 */
  catalogExpired?: boolean;
  planDigest?: string;
  plan?: {
    kernel: { version: string; digest: string; migration: string };
    packages: UpdatePlannedPackage[];
  };
  /** Whether the plan includes a kernel self-upgrade (target kernel != running). */
  includesKernel?: boolean;
  task?: {
    instanceId: string;
    baselineGeneration: number;
    targetDigest: string;
    idempotencyKey: string;
  };
  requiresAuthorization?: boolean;
}

export interface UpdateSubmitResponse {
  submitted: boolean;
  idempotencyKey: string;
  planDigest: string;
  catalogExpired?: boolean;
}

/** `GET /admin/updates/results`：updater 回写的最近结果。 */
export interface UpdateResultsResponse {
  results: Array<{ idempotencyKey: string; result: UpdateTaskResultView }>;
}

/** `GET /admin/updates/results/:key`。 */
export interface UpdateResultResponse {
  result: UpdateTaskResultView;
}

/**
 * `POST /admin/updates/check`：显式「检查更新」的结果。
 *
 * - `checked=false` + `throttled=true`：在冷却/退避期内，**没有**发网络请求；
 *   用 `retryAtMs` 告诉管理员还要等多久。
 * - `checked=false` + `catalog.state==='unconfigured'`：目录源被显式关闭。
 * - `checked=true` 且 `catalog.state==='ready'`：拿到验签通过的快照，`plan` 是随求解结果。
 */
export interface UpdateCheckResponse {
  checked: boolean;
  throttled: boolean;
  retryAtMs: number;
  catalog: UpdateCatalogView;
  plan: UpdatePlanResponse | null;
}

/** updater 自升级请求（共享卷上的 `self-update-request.json`）。 */
export interface UpdateSelfUpdateRequestView {
  candidateDigest: string;
  requestedBy: string;
  requestedAt: string;
}

/** `GET /admin/updates/self-update`。 */
export interface UpdateSelfUpdateResponse {
  request: UpdateSelfUpdateRequestView | null;
}

/** `POST /admin/updates/self-update`。 */
export interface UpdateSelfUpdateSubmitResponse {
  submitted: boolean;
  request: UpdateSelfUpdateRequestView;
}

/** `DELETE /admin/updates/self-update`。 */
export interface UpdateSelfUpdateCancelResponse {
  cleared: boolean;
}

/** Progress of the web tier's plugin-frontend rebuild/reload (GET /admin/plugins/frontend-status). */
export type FrontendApplyState = 'pending' | 'building' | 'restarting' | 'succeeded' | 'failed';

/** What kind of frontend change is being applied. */
export type FrontendApplyAction = 'install' | 'update' | 'remove';
export type FrontendApplyTarget = 'plugin' | 'theme';

export interface FrontendApplyStatus {
  state: FrontendApplyState;
  /** When this status was written (ISO). */
  at: string;
  /** Request timestamp this status corresponds to, if any. */
  requestedAt: string | null;
  /** Human-readable name of the plugin/theme being applied. */
  label?: string;
  target?: FrontendApplyTarget;
  action?: FrontendApplyAction;
  /** 1-based current step. */
  step?: number;
  /** Ordered step names for this apply. */
  steps?: string[];
  /** One-line description of what is happening right now. */
  detail?: string;
  message?: string;
}

/** Response of GET /admin/plugins/frontend-status. Null when never applied. */
export interface FrontendApplyStatusResponse {
  status: FrontendApplyStatus | null;
}

/** A dashboard widget contributed by an active plugin's UI extension. */
export interface AdminDashboardWidget extends AdminDashboardWidgetMeta {
  pluginId: string;
}

/** Response of GET /admin/ui/widgets. */
export interface AdminDashboardWidgetsResponse {
  widgets: AdminDashboardWidget[];
}

/** A declared permission string contributed by plugins and the platform. */
export interface PermissionInfo {
  id: string;
  key: string;
  name: string;
  /** Optional human-readable explanation supplied by the declaring plugin. */
  description: string | null;
}

/** Response of GET /admin/permissions. */
export interface PermissionInfoListResponse {
  permissions: PermissionInfo[];
}

/** Base permission group row without its permission list. */
export interface PermissionGroupInfo {
  id: string;
  name: string;
  description: string | null;
  /** 代理折扣（%），0-99；商店结账按用户所在组的最大折扣计价，null=无折扣。 */
  discount: number | null;
}

/** A permission group including its granted permissions. */
export interface PermissionGroupView extends PermissionGroupInfo {
  /** Number of users assigned to this group. */
  memberCount: number;
  /** Built-in admin/user groups: load-bearing and cannot be deleted. */
  structural: boolean;
  permissions: Array<Pick<PermissionInfo, 'key' | 'name' | 'description'>>;
}

/** Response of GET /admin/permission-groups. */
export interface PermissionGroupListResponse {
  groups: PermissionGroupView[];
}

/** Input to POST /admin/permission-groups. */
export interface PermissionGroupCreateInput {
  name: string;
  description?: string;
  discount?: number | null;
}

/** Input to PATCH /admin/permission-groups/:id (permissionKeys replaces the set). */
export interface PermissionGroupUpdateInput {
  name?: string;
  description?: string;
  permissionKeys?: string[];
  discount?: number | null;
}

/** Response of POST /admin/permission-groups. */
export interface PermissionGroupMutationResponse {
  group: PermissionGroupInfo;
}

/** Response of PATCH /admin/permission-groups/:id. */
export interface PermissionGroupPatchResponse {
  updated: boolean;
}

/** Response of DELETE /admin/permission-groups/:id. */
export interface PermissionGroupDeleteResponse {
  deleted: boolean;
}

/** A role template contributed by an active plugin. */
export interface RbacTemplateEntry {
  pluginId: string;
  permission: string;
}

/** Response of GET /admin/rbac/templates. */
export interface RbacTemplatesResponse {
  templates: RbacTemplateEntry[];
}

/** Response of PATCH /admin/plugins/:id. */
export interface PluginToggleResponse {
  id: string;
  enabled: boolean;
}

/** Source of the active package signing public key. */
export type SigningSource = 'env' | 'stored' | 'disabled';

/** Public signing policy exposed to the admin settings UI. */
export interface SigningStatus {
  source: SigningSource;
  configured: boolean;
  fingerprint: string | null;
  publicKey: string | null;
}

/**
 * 运行期内核配置的一条（ADR-0026）。
 *
 * `name` 与 `envSchema` 里的变量名一致，后台界面按它渲染行标题——它是技术标识符，
 * 不是待翻译文案。`source` 说明当前值来自数据库覆盖、环境变量还是字段默认值。
 */
export interface AdminRuntimeConfigEntry {
  name: string;
  group: 'auth' | 'session' | 'media' | 'openapi' | 'plugins' | 'audit' | 'agent';
  /** 当前生效值（已是运行期类型：数字/布尔/字符串）。 */
  value: unknown;
  source: 'stored' | 'env' | 'default';
  /** 环境变量里的值；未设置时为 null。 */
  envValue: unknown;
}

/** Response of GET /admin/config and of every write to it. */
export interface AdminConfigResponse {
  entries: AdminRuntimeConfigEntry[];
}

/** Response of GET/PATCH /admin/signing. */
export interface SigningResponse {
  signing: SigningStatus;
}

/** Public, non-secret platform identity managed by administrators. */
export interface PlatformInfo {
  name: string;
  description: string;
  url: string | null;
}

export interface PlatformInfoResponse {
  platform: PlatformInfo;
}

export const DEFAULT_PLATFORM_INFO: PlatformInfo = {
  name: 'StackPanel',
  description: 'API 优先的微内核插件式数字商品与托管业务管理系统。',
  url: null,
};

/** Platform-level brand identity, exposed as API-relative asset URLs. */
export interface PlatformBrand {
  logo: string | null;
  favicon: string | null;
}

export interface PlatformBrandResponse {
  brand: PlatformBrand;
}

/** A package entry available from the local application market. */
export interface MarketPackage {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  kind: 'plugin' | 'theme';
  /** Whether this package is currently installed. */
  installed: boolean;
  /** Version of the installed package, when installed. */
  installedVersion?: string | null;
  /** True when a newer version than the installed one is available. */
  upgradable: boolean;
  /** Whether the installed version matches the market (same build). */
  current: boolean;
  /** Whether the package is a built-in shipped with the kernel. */
  builtin: boolean;
  /** Frontend availability summary (pages/finders) when the package ships UI. */
  frontend?: {
    available: boolean;
    pages: Array<{ path: string; component: string }>;
    finders: string[];
  };
}

export interface MarketPluginsResponse {
  plugins: MarketPackage[];
}

export interface MarketThemesResponse {
  themes: MarketPackage[];
}

export interface MarketInstallResponse {
  installed: boolean;
  upgraded: boolean;
  id: string;
  version: string;
}

/* -------------------- 开发者控制台（DEV-CONSOLE P4） -------------------- */

/** 渠道伙伴状态。 */
export type ResellerStatus = 'ACTIVE' | 'DISABLED';

/** 出站 webhook 投递状态。 */
export type WebhookDeliveryStatus = 'PENDING' | 'DELIVERING' | 'SUCCEEDED' | 'FAILED';

/**
 * 渠道伙伴公开视图（`GET /admin/developer/resellers`）。
 * 私钥永不出圈：只以 `hasWebhookKey` 布尔暴露。
 */
export interface ResellerView {
  id: string;
  name: string;
  status: string;
  keyId: string;
  publicKey: string;
  hasWebhookKey: boolean;
  webhookPublicKey: string | null;
  webhookUrl: string | null;
  scopes: string[];
  rateLimitRpm: number;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResellerListResponse {
  resellers: ResellerView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ResellerDetailResponse {
  reseller: ResellerView;
  deliveries: WebhookDeliveryView[];
}

/** 出站 webhook 投递记录视图。 */
export interface WebhookDeliveryView {
  id: string;
  resellerId: string;
  /** 渠道名称（列表接口回填，详情接口为 null）。 */
  resellerName: string | null;
  event: string;
  url: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  responseCode: number | null;
  error: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryListResponse {
  deliveries: WebhookDeliveryView[];
  total: number;
  page: number;
  pageSize: number;
}

/** 分发概览计数。 */
export interface DeveloperOverview {
  resellers: { total: number; active: number };
  webhookDeliveries: { pending: number; failed: number; succeeded: number };
  calls: { last24h: number; total: number };
}

export interface DeveloperOverviewResponse {
  overview: DeveloperOverview;
}

/* ---------------- 开发者控制台写端点（CONSOLE-WRITE） ---------------- */

/** 渠道可授予的能力 scope（与 `/sp/v1` 一致）。 */
export type DeveloperSpScope =
  'catalog:read' | 'order:read' | 'order:write' | 'service:read' | 'service:write';

/** 新建渠道请求体。 */
export interface CreateResellerInput {
  name: string;
  scopes?: DeveloperSpScope[];
  rateLimitRpm?: number;
  webhookUrl?: string;
}

/** 更新渠道请求体；`webhookUrl: null` 表示清空回调地址。 */
export interface UpdateResellerInput {
  name?: string;
  status?: ResellerStatus;
  scopes?: DeveloperSpScope[];
  rateLimitRpm?: number;
  webhookUrl?: string | null;
}

/**
 * 新建 / 轮换密钥的响应：`inboundPrivateKey` 仅此一次返回，平台只保存公钥，
 * 之后不可检索。操作者须立即交付伙伴。
 */
export interface ResellerKeyResponse {
  reseller: ResellerView;
  inboundPrivateKey: string;
}

export interface ResellerMutationResponse {
  reseller: ResellerView;
}

export interface ResellerDeleteResponse {
  deleted: boolean;
}

/* ----------------------------- 币种治理 ----------------------------- */

/** 启用的币种及显示元数据（`GET /currency-definitions`）。 */
export interface CurrencyDefinitionView {
  code: string;
  name: string;
  symbol: string;
  minorUnit: number;
}

export interface CurrencyDefinitionListResponse {
  currencies: CurrencyDefinitionView[];
}

/** 管理端币种条目：含启用状态、引用状态与是否结算币种。 */
export interface AdminCurrencyDefinitionView extends CurrencyDefinitionView {
  enabled: boolean;
  referenced: boolean;
  settlement: boolean;
  /** 该币种下的示例格式化结果，便于后台核对小数位。 */
  sample: string;
}

export interface AdminCurrencyDefinitionListResponse {
  currencies: AdminCurrencyDefinitionView[];
  settlementCurrency: string;
}

export interface CurrencyDefinitionMutationResponse {
  currency: AdminCurrencyDefinitionView;
}

/** 平台结算币种（`GET/PUT /admin/settings/settlement-currency`）。 */
export interface SettlementCurrencyResponse {
  settlementCurrency: string;
  candidates?: CurrencyDefinitionView[] | undefined;
}

/** 管理端汇率行（含来源、更新时间和有效期）。 */
export interface AdminFxRateView {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  source: string;
  validUntil: string | null;
  updatedAt: string;
}

export interface AdminFxRateListResponse {
  settlementCurrency: string;
  rates: AdminFxRateView[];
}

/** Admin-visible sales channel row (with its payment methods). */
export interface AdminSalesChannel {
  id: string;
  code: string;
  name: string;
  terminal: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  methods: AdminPaymentMethod[];
}

/**
 * Admin-visible `payment_methods` row.
 *
 * `config` is provider-specific and may contain secrets (bank account, QR URL),
 * so it is only ever returned on the admin surface — never to buyers.
 */
export interface AdminPaymentMethod {
  id: string;
  channelId: string;
  providerId: string;
  /**
   * Provider family from the live runtime, or null when the plugin is gone.
   * Manual providers need collection details in `config`; gateways do not.
   */
  providerMode?: 'gateway' | 'manual' | null;
  name: string;
  enabled: boolean;
  scene: string;
  currencies: string[];
  config: unknown;
  sortOrder: number;
  createdAt: string;
}

export interface AdminSalesChannelListResponse {
  channels: AdminSalesChannel[];
  /** Every payment provider the runtime currently exposes (for a picker). */
  providers?: Array<{
    id: string;
    name: string;
    mode: 'gateway' | 'manual';
    methods: Array<{ id: string; label: string }>;
  }>;
}

export interface AdminPaymentMethodMutationResponse {
  method: AdminPaymentMethod;
}
