import { z } from 'zod';
import { ApiError } from './errors.js';
import type { ProblemDetails } from './errors.js';
import type {
  FrontendDescriptor,
  FrontendSettings,
  SettingsResponse,
  SettingsSchemaResponse,
} from './frontend.js';
import {
  activeThemeResponseSchema,
  apiTokenCreateResponseSchema,
  apiTokenListResponseSchema,
  apiTokenScopesResponseSchema,
  apiTokenUpdateResponseSchema,
  auditLogResponseSchema,
  adminDashboardWidgetsResponseSchema,
  adminActionsResponseSchema,
  adminPluginsResponseSchema,
  adminThemesResponseSchema,
  connectedIdentityListResponseSchema,
  currentUserResponseSchema,
  developerOverviewResponseSchema,
  frontendAuditResponseSchema,
  frontendApplyStatusResponseSchema,
  frontendDescriptorSchema,
  healthSchema,
  loginResponseSchema,
  marketInstallResponseSchema,
  marketPluginsResponseSchema,
  marketThemesResponseSchema,
  navListResponseSchema,
  notificationListResponseSchema,
  notificationMarkAllResponseSchema,
  notificationUnreadCountResponseSchema,
  oauthAuthorizeResponseSchema,
  oauthProviderListResponseSchema,
  okResponseSchema,
  permissionCheckResponseSchema,
  pluginFrontendsResponseSchema,
  pluginToggleResponseSchema,
  permissionListSchema,
  permissionGroupListSchema,
  permissionGroupMutationResponseSchema,
  permissionGroupPatchResponseSchema,
  permissionGroupDeleteResponseSchema,
  adminServiceMutationResponseSchema,
  adminUserCreateResponseSchema,
  adminUserDetailResponseSchema,
  adminUserMutationResponseSchema,
  adminUserServicesResponseSchema,
  adminUserUpstreamServicesResponseSchema,
  storeProductTypeListResponseSchema,
  upstreamSourceListResponseSchema,
  upstreamProductsResponseSchema,
  upstreamProductResponseSchema,
  impersonateResponseSchema,
  walletAdjustResponseSchema,
  rbacTemplatesResponseSchema,
  readinessSchema,
  resellerDetailResponseSchema,
  resellerDeleteResponseSchema,
  resellerKeyResponseSchema,
  resellerListResponseSchema,
  resellerMutationResponseSchema,
  sessionInfoResponseSchema,
  signingResponseSchema,
  platformInfoResponseSchema,
  platformBrandResponseSchema,
  settingsResponseSchema,
  settingsSchemaResponseSchema,
  themePreviewMutationResponseSchema,
  themePreviewResponseSchema,
  themePatchResponseSchema,
  themesResponseSchema,
  userListResponseSchema,
  webhookDeliveryListResponseSchema,
} from './schemas.js';
import type {
  ActiveThemeResponse,
  AdminDashboardWidgetsResponse,
  AdminActionsResponse,
  AuditLogResponse,
  AdminPluginsResponse,
  FrontendApplyStatusResponse,
  AdminThemesResponse,
  AdminProductsResponse,
  AdminServiceMutationResponse,
  AdminUserCreateResponse,
  AdminUserDetailResponse,
  AdminUserMutationResponse,
  AdminUserServicesResponse,
  AdminUserUpstreamServicesResponse,
  ImpersonateResponse,
  StoreProductTypeListResponse,
  UpstreamProductResponse,
  UpstreamProductsResponse,
  UpstreamSourceListResponse,
  WalletAdjustResponse,
  ConnectedIdentityListResponse,
  CurrentUserResponse,
  SessionInfoResponse,
  ApiTokenCreateResponse,
  ApiTokenListResponse,
  ApiTokenScopesResponse,
  ApiTokenUpdateResponse,
  FrontendAuditAction,
  Health,
  LoginResponse,
  MarketInstallResponse,
  MarketPluginsResponse,
  MarketThemesResponse,
  NavListResponse,
  NotificationListResponse,
  NotificationMarkAllResponse,
  NotificationUnreadCountResponse,
  OAuthAuthorizeResponse,
  OAuthProviderListResponse,
  PermissionCheckResponse,
  PluginFrontendsResponse,
  PluginToggleResponse,
  PlatformInfoResponse,
  PlatformBrandResponse,
  PermissionGroupCreateInput,
  PermissionGroupDeleteResponse,
  PermissionGroupListResponse,
  PermissionGroupMutationResponse,
  PermissionGroupPatchResponse,
  PermissionGroupUpdateInput,
  PermissionInfoListResponse,
  RbacTemplatesResponse,
  SigningResponse,
  Readiness,
  ThemePreviewMutationResponse,
  ThemePreviewResponse,
  ThemePatchResponse,
  ThemesResponse,
  UserListResponse,
  DeveloperOverviewResponse,
  CreateResellerInput,
  UpdateResellerInput,
  ResellerDetailResponse,
  ResellerDeleteResponse,
  ResellerKeyResponse,
  ResellerListResponse,
  ResellerMutationResponse,
  WebhookDeliveryListResponse,
} from './types.js';

export interface ApiClientOptions {
  /** Base URL of the StackPanel API, e.g. `http://127.0.0.1:3001`. */
  baseUrl: string;
  /** Request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Injectable fetch (useful for tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Bearer token sent on every request (if set). */
  token?: string;
}

/**
 * Perform a JSON request and validate the response against `schema`.
 * Throws {@link ApiError} on network failure, timeout, non-2xx, or invalid payload.
 */
async function request<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body: unknown | undefined;
    token: string | undefined;
  },
  timeoutMs: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(url, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const problem = json as Partial<ProblemDetails> | undefined;
      const legacyError =
        json && typeof json === 'object' && 'error' in json
          ? String((json as { error?: unknown }).error ?? '')
          : '';
      const message =
        (typeof problem?.detail === 'string' && problem.detail) ||
        (typeof problem?.title === 'string' && problem.title) ||
        legacyError ||
        `请求失败（HTTP ${res.status}）`;
      throw new ApiError(message, {
        status: res.status,
        ...(typeof problem?.code === 'string' ? { code: problem.code } : {}),
        ...(typeof problem?.requestId === 'string' ? { requestId: problem.requestId } : {}),
        ...(Array.isArray(problem?.errors) ? { errors: problem.errors } : {}),
        details: json,
      });
    }
    if (json === undefined) return undefined as T;
    return schema.parse(json);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(`请求超时（${timeoutMs}ms）`, {
        status: 0,
        code: 'timeout',
      });
    }
    throw new ApiError('网络请求失败', {
      status: 0,
      code: 'network',
      details: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Type-safe client for the StackPanel API. Zero business logic, validation only. */
export class ApiClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return request(
      this.#fetch,
      `${this.baseUrl}${path}`,
      { method: 'GET', body: undefined, token: this.token },
      this.timeoutMs,
      schema,
    );
  }

  post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return request(
      this.#fetch,
      `${this.baseUrl}${path}`,
      { method: 'POST', body, token: this.token },
      this.timeoutMs,
      schema,
    );
  }

  patch<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return request(
      this.#fetch,
      `${this.baseUrl}${path}`,
      { method: 'PATCH', body, token: this.token },
      this.timeoutMs,
      schema,
    );
  }

  del<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return request(
      this.#fetch,
      `${this.baseUrl}${path}`,
      { method: 'DELETE', body: undefined, token: this.token },
      this.timeoutMs,
      schema,
    );
  }

  /** Read installed themes (public list). */
  getThemes(): Promise<ThemesResponse> {
    return this.get('/themes', themesResponseSchema);
  }

  /** Read the currently active theme, if any. */
  getActiveTheme(): Promise<ActiveThemeResponse> {
    return this.get('/themes/active', activeThemeResponseSchema);
  }

  /** Read all installed themes including admin metadata. */
  getAdminThemes(): Promise<AdminThemesResponse> {
    return this.get('/admin/themes', adminThemesResponseSchema);
  }

  /** Activate a theme (deactivates the previous active theme). */
  activateTheme(id: string): Promise<ThemePatchResponse> {
    return this.patch(
      `/admin/themes/${encodeURIComponent(id)}`,
      { active: true },
      themePatchResponseSchema,
    );
  }

  /** Remove an installed non-active, non-default theme. */
  deleteTheme(id: string): Promise<void> {
    return this.del(`/admin/themes/${encodeURIComponent(id)}`, z.void());
  }

  /** Read all registered plugins with their source/enabled state. */
  getAdminPlugins(): Promise<AdminPluginsResponse> {
    return this.get('/admin/plugins', adminPluginsResponseSchema);
  }

  /** Read plugin-frontend rebuild/reload progress of the web tier. */
  getFrontendApplyStatus(): Promise<FrontendApplyStatusResponse> {
    return this.get('/admin/plugins/frontend-status', frontendApplyStatusResponseSchema);
  }

  /** Read the append-only audit trail (admin only). */
  getAuditLog(
    page = 1,
    pageSize = 50,
    filters: { action?: string; resource?: string; actorId?: string } = {},
  ): Promise<AuditLogResponse> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (filters.action) params.set('action', filters.action);
    if (filters.resource) params.set('resource', filters.resource);
    if (filters.actorId) params.set('actorId', filters.actorId);
    return this.get(`/admin/audit-log?${params.toString()}`, auditLogResponseSchema);
  }

  /** Enable or disable a plugin at runtime (no restart). */
  togglePlugin(id: string, enabled: boolean): Promise<PluginToggleResponse> {
    return this.patch(
      `/admin/plugins/${encodeURIComponent(id)}`,
      { enabled },
      pluginToggleResponseSchema,
    );
  }

  /** Remove a dynamic plugin (its routes go away immediately). */
  deletePlugin(id: string): Promise<void> {
    return this.del(`/admin/plugins/${encodeURIComponent(id)}`, z.void());
  }

  getHealth(): Promise<Health> {
    return this.get('/health', healthSchema);
  }

  getReadiness(): Promise<Readiness> {
    return this.get('/ready', readinessSchema);
  }

  /** Read public, non-secret platform identity. */
  getPlatformInfo(): Promise<PlatformInfoResponse> {
    return this.get('/platform/info', platformInfoResponseSchema);
  }

  /** Read the platform brand (logo/favicon) as API-relative asset URLs. */
  getPlatformBrand(): Promise<PlatformBrandResponse> {
    return this.get('/platform/brand', platformBrandResponseSchema);
  }

  /** Read platform identity from the admin settings surface. */
  getAdminPlatformInfo(): Promise<PlatformInfoResponse> {
    return this.get('/admin/platform/info', platformInfoResponseSchema);
  }

  /** Update the validated, non-secret platform identity. */
  updatePlatformInfo(platform: PlatformInfoResponse['platform']): Promise<PlatformInfoResponse> {
    return this.patch('/admin/platform/info', platform, platformInfoResponseSchema);
  }

  login(email: string, password: string): Promise<LoginResponse> {
    return this.post('/login', { email, password }, loginResponseSchema);
  }

  /** Register a new local account (login plugin). */
  register(email: string, password: string): Promise<LoginResponse> {
    return this.post('/register', { email, password }, loginResponseSchema);
  }

  /** Read the authenticated account identity. */
  getCurrentUser(): Promise<CurrentUserResponse> {
    return this.get('/auth/me', currentUserResponseSchema);
  }

  /** Lightweight session probe (never 401s); used by the web BFF / proxy. */
  getSession(): Promise<SessionInfoResponse> {
    return this.get('/auth/session', sessionInfoResponseSchema);
  }

  /** List third-party identities bound to the current account. */
  getConnectedIdentities(): Promise<ConnectedIdentityListResponse> {
    return this.get('/auth/identities', connectedIdentityListResponseSchema);
  }

  /** End the authenticated session. */
  logout(): Promise<void> {
    return this.post('/logout', {}, z.void());
  }

  /** Resolve the browser authorization URL for an OAuth provider flow. */
  getOAuthProviders(): Promise<OAuthProviderListResponse> {
    return this.get('/auth/oauth/providers', oauthProviderListResponseSchema);
  }

  /** Resolve the browser authorization URL for an OAuth provider flow. */
  getOAuthAuthorizeUrl(
    providerId: string,
    state: string,
    options: { codeChallenge?: string; nonce?: string } = {},
  ): Promise<OAuthAuthorizeResponse> {
    const query = new URLSearchParams({ state });
    if (options.codeChallenge) query.set('codeChallenge', options.codeChallenge);
    if (options.nonce) query.set('nonce', options.nonce);
    return this.get(
      `/auth/oauth/${providerId}/authorize?${query.toString()}`,
      oauthAuthorizeResponseSchema,
    );
  }

  /** Complete an OAuth login with the provider-returned code and state. */
  completeOAuthLogin(
    providerId: string,
    code: string,
    state: string,
    options: { codeVerifier?: string; nonce?: string } = {},
  ): Promise<LoginResponse> {
    return this.post(
      `/auth/oauth/${providerId}/callback`,
      { code, state, ...options },
      loginResponseSchema,
    );
  }

  /** Read navigation items contributed by plugins for a surface. */
  getNav(surface: 'public' | 'account' | 'admin'): Promise<NavListResponse> {
    return this.get(`/nav/${surface}`, navListResponseSchema);
  }

  /** Read the active/installed theme's compiled frontend descriptor. */
  getThemeFrontend(id: string): Promise<FrontendDescriptor> {
    return this.get(`/themes/${encodeURIComponent(id)}/frontend`, frontendDescriptorSchema);
  }

  /** Read an installed plugin's compiled frontend descriptor. */
  getPluginFrontend(id: string): Promise<FrontendDescriptor> {
    return this.get(`/plugins/${encodeURIComponent(id)}/frontend`, frontendDescriptorSchema);
  }

  /** List compiled frontend packages contributed by active plugins. */
  getPluginFrontends(): Promise<PluginFrontendsResponse> {
    return this.get('/plugins/frontends', pluginFrontendsResponseSchema);
  }

  /** Check whether the current session has a plugin permission. */
  checkPermission(permission: string): Promise<PermissionCheckResponse> {
    return this.get(
      `/permissions/check?permission=${encodeURIComponent(permission)}`,
      permissionCheckResponseSchema,
    );
  }

  /** List admin users, optionally filtered by search query, status or group. */
  listAdminUsers(options?: {
    page?: number;
    pageSize?: number;
    q?: string;
    status?: 'ACTIVE' | 'DISABLED';
    groupId?: string;
  }): Promise<UserListResponse> {
    const query = new URLSearchParams();
    if (options?.page !== undefined) query.set('page', String(options.page));
    if (options?.pageSize !== undefined) query.set('pageSize', String(options.pageSize));
    if (options?.q) query.set('q', options.q);
    if (options?.status) query.set('status', options.status);
    if (options?.groupId) query.set('groupId', options.groupId);
    const qs = query.toString();
    return this.get(`/admin/users${qs ? `?${qs}` : ''}`, userListResponseSchema);
  }

  /** Read the full admin user detail aggregate (wallet, services, orders, ledger). */
  getAdminUser(id: string): Promise<AdminUserDetailResponse> {
    return this.get(`/admin/users/${encodeURIComponent(id)}`, adminUserDetailResponseSchema);
  }

  /** Update a user's status and/or permission groups. */
  updateAdminUser(
    id: string,
    input: { status?: 'ACTIVE' | 'DISABLED'; groupIds?: string[] },
  ): Promise<AdminUserMutationResponse> {
    const body: Record<string, unknown> = {};
    if (input.status !== undefined) body.status = input.status;
    if (input.groupIds !== undefined) body.groupIds = input.groupIds;
    return this.patch(
      `/admin/users/${encodeURIComponent(id)}`,
      body,
      adminUserMutationResponseSchema,
    );
  }

  /** Create a new admin-managed user. */
  createAdminUser(input: {
    email: string;
    password?: string;
    status?: 'ACTIVE' | 'DISABLED';
    groupIds?: string[];
  }): Promise<AdminUserCreateResponse> {
    const body: Record<string, unknown> = { email: input.email };
    if (input.password !== undefined) body.password = input.password;
    if (input.status !== undefined) body.status = input.status;
    if (input.groupIds !== undefined) body.groupIds = input.groupIds;
    return this.post('/admin/users', body, adminUserCreateResponseSchema);
  }

  /** Adjust a user's wallet balance (positive or negative), recorded in the ledger. */
  adjustUserWallet(
    id: string,
    input: { amount: number; note: string },
  ): Promise<WalletAdjustResponse> {
    return this.post(
      `/admin/users/${encodeURIComponent(id)}/wallet`,
      input,
      walletAdjustResponseSchema,
    );
  }

  /** Issue a session for the target user so the admin can access their backend. */
  impersonateUser(id: string): Promise<ImpersonateResponse> {
    return this.post(
      `/admin/users/${encodeURIComponent(id)}/impersonate`,
      {},
      impersonateResponseSchema,
    );
  }

  /** List a user's purchased/gifted services. */
  getAdminUserServices(id: string): Promise<AdminUserServicesResponse> {
    return this.get(
      `/admin/users/${encodeURIComponent(id)}/services`,
      adminUserServicesResponseSchema,
    );
  }

  /** Gift a service to a user (creates ServiceInstance rows directly). */
  giftUserService(
    id: string,
    input: { productId: string; quantity?: number; expiresAt?: string },
  ): Promise<AdminUserServicesResponse> {
    return this.post(
      `/admin/users/${encodeURIComponent(id)}/services`,
      input,
      adminUserServicesResponseSchema,
    );
  }

  /** Update a user's service (expiry time / status). */
  updateAdminUserService(
    userId: string,
    serviceId: string,
    input: { expiresAt?: string | null; status?: string },
  ): Promise<AdminServiceMutationResponse> {
    return this.patch(
      `/admin/users/${encodeURIComponent(userId)}/services/${encodeURIComponent(serviceId)}`,
      input,
      adminServiceMutationResponseSchema,
    );
  }

  /** Delete a user's service. */
  deleteAdminUserService(userId: string, serviceId: string): Promise<void> {
    return this.del(
      `/admin/users/${encodeURIComponent(userId)}/services/${encodeURIComponent(serviceId)}`,
      z.void(),
    );
  }

  /** List upstream already-purchased services available to bind to a user. */
  getAdminUserUpstreamServices(id: string): Promise<AdminUserUpstreamServicesResponse> {
    return this.get(
      `/admin/users/${encodeURIComponent(id)}/upstream-services`,
      adminUserUpstreamServicesResponseSchema,
    );
  }

  /** Bind an upstream already-purchased service to a user. */
  bindAdminUserUpstreamService(
    id: string,
    input: { sourceId: string; providerServiceId: string },
  ): Promise<AdminUserServicesResponse> {
    return this.post(
      `/admin/users/${encodeURIComponent(id)}/upstream-services`,
      input,
      adminUserServicesResponseSchema,
    );
  }

  /** Unbind an upstream service from a user (removes the local binding only). */
  unbindAdminUserUpstreamService(userId: string, serviceId: string): Promise<void> {
    return this.del(
      `/admin/users/${encodeURIComponent(userId)}/upstream-services/${encodeURIComponent(serviceId)}`,
      z.void(),
    );
  }

  /** List active products for admin pickers (served by the store plugin). */
  async getAdminProducts(): Promise<AdminProductsResponse> {
    const data = await this.get(
      '/store/admin/products?page=1&pageSize=100',
      z.object({
        products: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              price: z.number(),
              currency: z.string(),
              fulfillmentType: z.string(),
              status: z.string(),
            })
            .passthrough(),
        ),
      }),
    );
    return {
      products: data.products
        .filter((product) => product.status === 'ACTIVE')
        .map((product) => ({
          id: product.id,
          name: product.name,
          price: product.price,
          currency: product.currency,
          fulfillmentType: product.fulfillmentType,
          status: product.status,
        })),
    };
  }

  /** List registered product types (for the store product form). */
  getStoreProductTypes(): Promise<StoreProductTypeListResponse> {
    return this.get('/store/product-types', storeProductTypeListResponseSchema);
  }

  /** List registered upstream product sources (installed upstream plugins). */
  getUpstreamSources(): Promise<UpstreamSourceListResponse> {
    return this.get('/store/upstream-sources', upstreamSourceListResponseSchema);
  }

  /** Search an upstream's products for association. */
  searchUpstreamProducts(providerId: string, query?: string): Promise<UpstreamProductsResponse> {
    const qs = query ? `?q=${encodeURIComponent(query)}` : '';
    return this.get(
      `/store/upstream-products/${encodeURIComponent(providerId)}${qs}`,
      upstreamProductsResponseSchema,
    );
  }

  /** Fetch a single upstream product (echo current association). */
  getUpstreamProduct(providerId: string, productId: string): Promise<UpstreamProductResponse> {
    return this.get(
      `/store/upstream-products/${encodeURIComponent(providerId)}/${encodeURIComponent(productId)}`,
      upstreamProductResponseSchema,
    );
  }

  /** List the current user's in-app notifications (newest first). */
  getNotifications(options?: {
    limit?: number;
    cursor?: string;
    unreadOnly?: boolean;
  }): Promise<NotificationListResponse> {
    const query = new URLSearchParams();
    if (options?.limit !== undefined) query.set('limit', String(options.limit));
    if (options?.cursor) query.set('cursor', options.cursor);
    if (options?.unreadOnly) query.set('unreadOnly', 'true');
    const qs = query.toString();
    return this.get(`/notifications${qs ? `?${qs}` : ''}`, notificationListResponseSchema);
  }

  /** Read the current user's unread notification count. */
  getNotificationUnreadCount(): Promise<NotificationUnreadCountResponse> {
    return this.get('/notifications/unread-count', notificationUnreadCountResponseSchema);
  }

  /** Mark one of the current user's notifications as read. */
  markNotificationRead(id: string): Promise<void> {
    return this.post(`/notifications/${encodeURIComponent(id)}/read`, {}, z.void());
  }

  /** Mark every unread notification of the current user as read. */
  markAllNotificationsRead(): Promise<NotificationMarkAllResponse> {
    return this.post('/notifications/read-all', {}, notificationMarkAllResponseSchema);
  }

  // --- Platform API tokens (open platform) ---------------------------------

  /** List the current user's API tokens (secrets are never returned). */
  getApiTokens(): Promise<ApiTokenListResponse> {
    return this.get('/me/api-tokens', apiTokenListResponseSchema);
  }

  /** Scopes the current user is allowed to grant, with display names. */
  getApiTokenScopes(): Promise<ApiTokenScopesResponse> {
    return this.get('/me/api-tokens/scopes', apiTokenScopesResponseSchema);
  }

  /** Create an API token; the plaintext is returned exactly once. */
  createApiToken(input: {
    name: string;
    scopes?: string[];
    ipAllowlist?: string[];
    expiresAt?: string | null;
  }): Promise<ApiTokenCreateResponse> {
    return this.post('/me/api-tokens', input, apiTokenCreateResponseSchema);
  }

  /** Rename, rescope, disable or re-enable one of the current user's tokens. */
  updateApiToken(
    id: string,
    input: {
      name?: string;
      scopes?: string[];
      ipAllowlist?: string[];
      status?: 'ACTIVE' | 'DISABLED';
      expiresAt?: string | null;
    },
  ): Promise<ApiTokenUpdateResponse> {
    return this.patch(
      `/me/api-tokens/${encodeURIComponent(id)}`,
      input,
      apiTokenUpdateResponseSchema,
    );
  }

  /** Revoke one of the current user's API tokens. */
  revokeApiToken(id: string): Promise<{ ok: boolean }> {
    return this.del(`/me/api-tokens/${encodeURIComponent(id)}`, okResponseSchema);
  }

  /** Record a frontend runtime audit event from the web shell. */
  recordFrontendAudit(
    action: FrontendAuditAction,
    pluginId: string,
    resourceId?: string,
    meta?: Record<string, string | number | boolean>,
  ): Promise<{ ok: boolean }> {
    return this.post(
      '/frontend/audit',
      { action, pluginId, ...(resourceId ? { resourceId } : {}), ...(meta ? { meta } : {}) },
      frontendAuditResponseSchema,
    );
  }

  /** Read a theme's settings schema (nullable when no frontend exists). */
  getThemeSettingsSchema(id: string): Promise<SettingsSchemaResponse> {
    return this.get(
      `/themes/${encodeURIComponent(id)}/settings-schema`,
      settingsSchemaResponseSchema,
    );
  }

  /** Read a plugin's settings schema (nullable when no frontend exists). */
  getPluginSettingsSchema(id: string): Promise<SettingsSchemaResponse> {
    return this.get(
      `/plugins/${encodeURIComponent(id)}/settings-schema`,
      settingsSchemaResponseSchema,
    );
  }

  /** Read the active theme's resolved settings, including schema defaults. */
  getThemeSettings(id: string): Promise<SettingsResponse> {
    return this.get(`/themes/${encodeURIComponent(id)}/settings`, settingsResponseSchema);
  }

  /** Read a plugin's resolved settings, including schema defaults. */
  getPluginSettings(id: string): Promise<SettingsResponse> {
    return this.get(`/plugins/${encodeURIComponent(id)}/settings`, settingsResponseSchema);
  }

  /** Update a theme's frontend settings (admin). */
  updateThemeSettings(id: string, settings: FrontendSettings): Promise<SettingsResponse> {
    return this.patch(
      `/admin/themes/${encodeURIComponent(id)}/settings`,
      { settings },
      settingsResponseSchema,
    );
  }

  /** Update a plugin's frontend settings (admin). */
  updatePluginSettings(id: string, settings: FrontendSettings): Promise<SettingsResponse> {
    return this.patch(
      `/admin/plugins/${encodeURIComponent(id)}/settings`,
      { settings },
      settingsResponseSchema,
    );
  }

  /** Read dashboard widgets contributed by active plugins. */
  getAdminDashboardWidgets(): Promise<AdminDashboardWidgetsResponse> {
    return this.get('/admin/ui/widgets', adminDashboardWidgetsResponseSchema);
  }

  /** Read role templates contributed by active plugins. */
  getRbacTemplates(): Promise<RbacTemplatesResponse> {
    return this.get('/admin/rbac/templates', rbacTemplatesResponseSchema);
  }

  /** List permission groups with their granted permissions (admin only). */
  getPermissionGroups(): Promise<PermissionGroupListResponse> {
    return this.get('/admin/permission-groups', permissionGroupListSchema);
  }

  /** Create a new permission group (admin only). */
  createPermissionGroup(
    input: PermissionGroupCreateInput,
  ): Promise<PermissionGroupMutationResponse> {
    return this.post('/admin/permission-groups', input, permissionGroupMutationResponseSchema);
  }

  /** Update a permission group's name/description/permissions (admin only). */
  updatePermissionGroup(
    id: string,
    input: PermissionGroupUpdateInput,
  ): Promise<PermissionGroupPatchResponse> {
    return this.patch(
      `/admin/permission-groups/${encodeURIComponent(id)}`,
      input,
      permissionGroupPatchResponseSchema,
    );
  }

  /** Delete a permission group; structural groups (admin/user) are refused (admin only). */
  deletePermissionGroup(id: string): Promise<PermissionGroupDeleteResponse> {
    return this.del(
      `/admin/permission-groups/${encodeURIComponent(id)}`,
      permissionGroupDeleteResponseSchema,
    );
  }

  /** List all declared permissions (admin only). */
  getPermissions(): Promise<PermissionInfoListResponse> {
    return this.get('/admin/permissions', permissionListSchema);
  }

  /** Read admin actions contributed by active plugin frontend packages. */
  getAdminActions(): Promise<AdminActionsResponse> {
    return this.get('/admin/ui/actions', adminActionsResponseSchema);
  }

  /** Read the current package signing policy. */
  getSigningStatus(): Promise<SigningResponse> {
    return this.get('/admin/signing', signingResponseSchema);
  }

  /** Set or clear the stored package signing public key (empty clears). */
  setSigningPublicKey(publicKey: string): Promise<SigningResponse> {
    return this.patch('/admin/signing', { publicKey }, signingResponseSchema);
  }

  /** Read the current admin-selected theme preview, if any. */
  getThemePreview(): Promise<ThemePreviewResponse> {
    return this.get('/admin/themes/preview', themePreviewResponseSchema);
  }

  /** Set the theme that should be rendered in preview mode. */
  setThemePreview(themeId: string): Promise<ThemePreviewMutationResponse> {
    return this.post('/admin/themes/preview', { themeId }, themePreviewMutationResponseSchema);
  }

  /** Clear the admin-selected theme preview. */
  clearThemePreview(): Promise<void> {
    return this.del('/admin/themes/preview', z.void());
  }

  /** List installable plugins from the local application market. */
  getMarketPlugins(): Promise<MarketPluginsResponse> {
    return this.get('/admin/market/plugins', marketPluginsResponseSchema);
  }

  /** List installable themes from the local application market. */
  getMarketThemes(): Promise<MarketThemesResponse> {
    return this.get('/admin/market/themes', marketThemesResponseSchema);
  }

  /** Install or upgrade a plugin from the local application market. */
  installMarketPlugin(id: string): Promise<MarketInstallResponse> {
    return this.post(
      `/admin/market/plugins/${encodeURIComponent(id)}/install`,
      {},
      marketInstallResponseSchema,
    );
  }

  /** Install or upgrade a theme from the local application market. */
  installMarketTheme(id: string): Promise<MarketInstallResponse> {
    return this.post(
      `/admin/market/themes/${encodeURIComponent(id)}/install`,
      {},
      marketInstallResponseSchema,
    );
  }

  /* -------------------- 开发者控制台（DEV-CONSOLE P4） -------------------- */

  /** 分发概览：渠道 / webhook 投递 / SP v1 调用计数。 */
  getDeveloperOverview(): Promise<DeveloperOverviewResponse> {
    return this.get('/admin/developer/overview', developerOverviewResponseSchema);
  }

  /** 渠道伙伴列表（分页）。 */
  listResellers(page = 1, pageSize = 20): Promise<ResellerListResponse> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    return this.get(`/admin/developer/resellers?${params.toString()}`, resellerListResponseSchema);
  }

  /** 渠道伙伴详情 + 最近 20 条 webhook 投递。 */
  getReseller(id: string): Promise<ResellerDetailResponse> {
    return this.get(
      `/admin/developer/resellers/${encodeURIComponent(id)}`,
      resellerDetailResponseSchema,
    );
  }

  /** webhook 投递记录（可按渠道 / 状态过滤）。 */
  listWebhookDeliveries(
    page = 1,
    pageSize = 20,
    filters: { resellerId?: string; status?: string } = {},
  ): Promise<WebhookDeliveryListResponse> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (filters.resellerId) params.set('resellerId', filters.resellerId);
    if (filters.status) params.set('status', filters.status);
    return this.get(
      `/admin/developer/webhook-deliveries?${params.toString()}`,
      webhookDeliveryListResponseSchema,
    );
  }

  /** SP v1 调用审计（`audit_logs` 中 `sp_v1.call`，可按渠道过滤）。 */
  listDeveloperCalls(
    page = 1,
    pageSize = 50,
    filters: { resellerId?: string } = {},
  ): Promise<AuditLogResponse> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (filters.resellerId) params.set('resellerId', filters.resellerId);
    return this.get(`/admin/developer/calls?${params.toString()}`, auditLogResponseSchema);
  }

  /** 新建渠道；响应一次性返回入站私钥，平台只存公钥。 */
  createReseller(input: CreateResellerInput): Promise<ResellerKeyResponse> {
    return this.post('/admin/developer/resellers', input, resellerKeyResponseSchema);
  }

  /** 更新渠道名称 / 状态 / scope / 限额 / 回调地址。 */
  updateReseller(id: string, input: UpdateResellerInput): Promise<ResellerMutationResponse> {
    return this.patch(
      `/admin/developer/resellers/${encodeURIComponent(id)}`,
      input,
      resellerMutationResponseSchema,
    );
  }

  /** 轮换渠道入站 Ed25519 密钥对；旧公钥立即失效，新私钥一次性返回。 */
  rotateResellerKey(id: string): Promise<ResellerKeyResponse> {
    return this.post(
      `/admin/developer/resellers/${encodeURIComponent(id)}/rotate-key`,
      {},
      resellerKeyResponseSchema,
    );
  }

  /** 删除渠道（级联其 webhook 投递记录）。 */
  deleteReseller(id: string): Promise<ResellerDeleteResponse> {
    return this.del(
      `/admin/developer/resellers/${encodeURIComponent(id)}`,
      resellerDeleteResponseSchema,
    );
  }
}
