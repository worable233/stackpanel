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
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
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
}

/** Response of GET /plugins/frontends. */
export interface PluginFrontendsResponse {
  plugins: PluginFrontendDescriptor[];
}

/** Response of GET /permissions/check. */
export interface PermissionCheckResponse {
  allowed: boolean;
}

/** Response of GET /admin/plugins. */
export interface AdminPluginsResponse {
  plugins: AdminPlugin[];
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
  permissions: Array<Pick<PermissionInfo, 'key' | 'name'>>;
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
  | 'catalog:read'
  | 'order:read'
  | 'order:write'
  | 'service:read'
  | 'service:write';

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
