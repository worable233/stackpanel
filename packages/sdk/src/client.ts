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
  adminCurrencyDefinitionListResponseSchema,
  adminFxRateListResponseSchema,
  adminFxRateViewSchema,
  adminPaymentCancelResultSchema,
  adminPaymentConfirmResultSchema,
  adminPaymentListResponseSchema,
  adminPaymentMethodMutationResponseSchema,
  adminSalesChannelListResponseSchema,
  apiTokenCreateResponseSchema,
  apiTokenListResponseSchema,
  seoPageListResponseSchema,
  seoPageUpsertResponseSchema,
  apiTokenScopesResponseSchema,
  apiTokenUpdateResponseSchema,
  auditLogResponseSchema,
  adminDashboardWidgetsResponseSchema,
  adminActionsResponseSchema,
  adminPluginsResponseSchema,
  adminThemesResponseSchema,
  authConfigResponseSchema,
  accountMutationResponseSchema,
  sendRegisterCodeResponseSchema,
  connectedIdentityListResponseSchema,
  currencyDefinitionListResponseSchema,
  currencyDefinitionMutationResponseSchema,
  currentUserResponseSchema,
  developerOverviewResponseSchema,
  frontendAuditResponseSchema,
  frontendApplyStatusResponseSchema,
  updateStatusResponseSchema,
  updatePolicyResponseSchema,
  updatePlanResponseSchema,
  updateSubmitResponseSchema,
  updateResultsResponseSchema,
  updateResultResponseSchema,
  updateCheckResponseSchema,
  updateSelfUpdateResponseSchema,
  updateSelfUpdateSubmitResponseSchema,
  updateSelfUpdateCancelResponseSchema,
  frontendDescriptorSchema,
  healthSchema,
  loginResponseSchema,
  marketInstallResponseSchema,
  marketPluginsResponseSchema,
  marketThemesResponseSchema,
  distributionRefreshResultSchema,
  distributionSourceResponseSchema,
  navListResponseSchema,
  adminNavResponseSchema,
  adminNavCustomResponseSchema,
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
  settlementCurrencyResponseSchema,
  setupStatusResponseSchema,
  bootstrapProvisionResponseSchema,
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
  AdminPaymentCancelResult,
  AdminPaymentConfirmResult,
  AdminPaymentListQuery,
  AdminPaymentListResponse,
} from './payments.js';
import type {
  ActiveThemeResponse,
  AdminDashboardWidgetsResponse,
  AdminActionsResponse,
  AuditLogResponse,
  AdminPluginsResponse,
  FrontendApplyStatusResponse,
  UpdateStatusResponse,
  UpdatePolicyView,
  UpdatePolicyPatch,
  UpdatePlanResponse,
  UpdateSubmitResponse,
  UpdateCheckResponse,
  UpdateResultsResponse,
  UpdateTaskResultView,
  UpdateSelfUpdateResponse,
  UpdateSelfUpdateSubmitResponse,
  UpdateSelfUpdateCancelResponse,
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
  AdminCurrencyDefinitionListResponse,
  AdminFxRateListResponse,
  AdminFxRateView,
  AdminPaymentMethodMutationResponse,
  AdminSalesChannelListResponse,
  CurrencyDefinitionListResponse,
  CurrencyDefinitionMutationResponse,
  SettlementCurrencyResponse,
  CurrentUserResponse,
  SessionInfoResponse,
  SetupStatusResponse,
  BootstrapOperationView,
  ApiTokenCreateResponse,
  ApiTokenListResponse,
  SeoPageListResponse,
  SeoPageUpsertInput,
  SeoPageUpsertResponse,
  ApiTokenScopesResponse,
  ApiTokenUpdateResponse,
  AuthConfigResponse,
  AccountMutationResponse,
  FrontendAuditAction,
  Health,
  LoginResponse,
  MarketInstallResponse,
  MarketPluginsResponse,
  MarketThemesResponse,
  NavListResponse,
  AdminNavResponse,
  AdminNavCustomResponse,
  AdminNavLayoutItemInput,
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
  SendRegisterCodeResponse,
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
import type {
  DistributionRefreshResult,
  DistributionSourceInput,
  DistributionSourceResponse,
} from './market.js';

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
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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

  put<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return request(
      this.#fetch,
      `${this.baseUrl}${path}`,
      { method: 'PUT', body, token: this.token },
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

  /** Read the update center status (policy, updater projection, catalog state). Never touches the network. */
  getUpdateStatus(): Promise<UpdateStatusResponse> {
    return this.get('/admin/updates/status', updateStatusResponseSchema);
  }

  /** Read the persisted auto-update policy on its own (settings page). */
  getUpdatePolicy(): Promise<{ policy: UpdatePolicyView }> {
    return this.get('/admin/updates/policy', updatePolicyResponseSchema);
  }

  /** Update the auto-update policy. */
  updateUpdatePolicy(patch: UpdatePolicyPatch): Promise<{ policy: UpdatePolicyView }> {
    return request(
      this.#fetch,
      `${this.baseUrl}/admin/updates/policy`,
      { method: 'PUT', body: patch, token: this.token },
      this.timeoutMs,
      updatePolicyResponseSchema,
    );
  }

  /**
   * Force one signed-catalog check (explicit admin action).
   *
   * Returns `checked:false, throttled:true` while the cooldown/backoff window is
   * open — that call does **not** reach GitHub. Rendering a page must never call
   * this; only a user action may.
   */
  checkUpdateCatalog(): Promise<UpdateCheckResponse> {
    return this.post('/admin/updates/check', {}, updateCheckResponseSchema);
  }

  /** Solve a full deployment plan from the signed catalog (no state change). */
  planUpdate(): Promise<UpdatePlanResponse> {
    return this.post('/admin/updates/plan', {}, updatePlanResponseSchema);
  }

  /**
   * Submit an update task to the instance-private channel.
   *
   * `acknowledge` and `allowExpired` must come from an explicit user decision —
   * never derived from the plan payload itself.
   */
  submitUpdate(
    input: { acknowledge?: boolean; allowExpired?: boolean; idempotencyKey?: string } = {},
  ): Promise<UpdateSubmitResponse> {
    return this.post('/admin/updates/submit', input, updateSubmitResponseSchema);
  }

  /** List recent update task results projected by the updater. */
  listUpdateResults(): Promise<UpdateResultsResponse> {
    return this.get('/admin/updates/results', updateResultsResponseSchema);
  }

  /** Read one update task result (phase/checkpoints/recovery) by idempotency key. */
  getUpdateResult(key: string): Promise<{ result: UpdateTaskResultView }> {
    return this.get(`/admin/updates/results/${encodeURIComponent(key)}`, updateResultResponseSchema);
  }

  /** Read the pending updater self-update request (if any). */
  getUpdateSelfUpdate(): Promise<UpdateSelfUpdateResponse> {
    return this.get('/admin/updates/self-update', updateSelfUpdateResponseSchema);
  }

  /** Queue an updater self-update for the given image digest. */
  submitUpdateSelfUpdate(candidateDigest: string): Promise<UpdateSelfUpdateSubmitResponse> {
    return this.post(
      '/admin/updates/self-update',
      { candidateDigest },
      updateSelfUpdateSubmitResponseSchema,
    );
  }

  /** Cancel a queued (not yet consumed) updater self-update request. */
  cancelUpdateSelfUpdate(): Promise<UpdateSelfUpdateCancelResponse> {
    return request(
      this.#fetch,
      `${this.baseUrl}/admin/updates/self-update`,
      { method: 'DELETE', body: undefined, token: this.token },
      this.timeoutMs,
      updateSelfUpdateCancelResponseSchema,
    );
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

  /** Read the public first-run setup state (never 401s). */
  getSetupStatus(): Promise<SetupStatusResponse> {
    return this.get('/setup/status', setupStatusResponseSchema);
  }

  /**
   * Claim an uninitialized instance by creating its first administrator. The
   * `setupToken` is only required when GET /setup/status reports
   * `tokenRequired`. Returns a session like login, so the caller can sign the
   * operator straight in.
   *
   * Only meaningful once `phase` is `needs_admin`; the provision app does not
   * register this route at all.
   */
  completeSetup(input: {
    email: string;
    password: string;
    setupToken?: string;
  }): Promise<LoginResponse> {
    const { email, password, setupToken } = input;
    return this.post(
      '/setup',
      { email, password, ...(setupToken ? { setupToken } : {}) },
      loginResponseSchema,
    );
  }

  /**
   * Submit infrastructure connection settings during first boot
   * (BOOTSTRAP-R1). Only the provision app exposes this route.
   *
   * The call returns as soon as the candidate is durably queued — validation,
   * migration and the first normal start happen in the upgrade runner, so the
   * browser must poll {@link getSetupStatus} rather than wait on this promise.
   */
  submitBootstrap(input: {
    setupToken: string;
    idempotencyKey: string;
    config: Record<string, string>;
  }): Promise<{ operation: BootstrapOperationView }> {
    return this.post(
      '/setup/provision',
      {
        setupToken: input.setupToken,
        idempotencyKey: input.idempotencyKey,
        config: input.config,
      },
      bootstrapProvisionResponseSchema,
    );
  }

  /**
   * Register a new local account (login plugin). `affid` is an optional
   * referral code carried over from the visitor's landing link; the login
   * plugin forwards it on `user.registered` for attribution. `code` is the
   * email verification code when the deployment requires a verified email;
   * `captchaToken` is the human-verification token from the widget.
   */
  register(
    email: string,
    password: string,
    options: { affid?: string | null; code?: string; captchaToken?: string } = {},
  ): Promise<LoginResponse> {
    const { affid, code, captchaToken } = options;
    return this.post(
      '/register',
      {
        email,
        password,
        ...(affid ? { affid } : {}),
        ...(code ? { code } : {}),
        ...(captchaToken ? { captchaToken } : {}),
      },
      loginResponseSchema,
    );
  }

  /** Request a registration email verification code (login plugin). */
  sendRegisterCode(
    email: string,
    options: { captchaToken?: string } = {},
  ): Promise<SendRegisterCodeResponse> {
    return this.post(
      '/register/send-code',
      { email, ...(options.captchaToken ? { captchaToken: options.captchaToken } : {}) },
      sendRegisterCodeResponseSchema,
    );
  }

  /** Read the public authentication policy (login plugin). */
  getAuthConfig(): Promise<AuthConfigResponse> {
    return this.get('/auth/config', authConfigResponseSchema);
  }

  changePassword(currentPassword: string, newPassword: string): Promise<AccountMutationResponse> {
    return this.post('/auth/password', { currentPassword, newPassword }, accountMutationResponseSchema);
  }

  changeEmail(currentPassword: string, email: string): Promise<AccountMutationResponse> {
    return this.post('/auth/email', { currentPassword, email }, accountMutationResponseSchema);
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

  /** 后台菜单编辑视图（含隐藏项与来源信息）。 */
  getAdminNav(surface: 'public' | 'account' | 'admin' = 'admin'): Promise<AdminNavResponse> {
    return this.get(`/admin/nav?surface=${surface}`, adminNavResponseSchema);
  }

  /** 保存一次排布：数组顺序即最终顺序，label 为空表示沿用默认文案。 */
  saveAdminNavLayout(
    surface: 'public' | 'account' | 'admin',
    items: AdminNavLayoutItemInput[],
  ): Promise<AdminNavResponse> {
    return this.put(`/admin/nav/${surface}`, { items }, adminNavResponseSchema);
  }

  addAdminNavItem(
    surface: 'public' | 'account' | 'admin',
    input: { label: string; href: string },
  ): Promise<AdminNavCustomResponse> {
    return this.post(`/admin/nav/${surface}/items`, input, adminNavCustomResponseSchema);
  }

  /** 删除一条覆写：自定义项消失，默认项恢复原样。 */
  deleteAdminNavItem(id: string): Promise<{ ok: boolean }> {
    return this.del(`/admin/nav/items/${id}`, okResponseSchema);
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
    sort?:
      | 'createdAt_desc'
      | 'createdAt_asc'
      | 'balance_desc'
      | 'balance_asc'
      | 'lastLoginAt_desc'
      | 'lastLoginAt_asc';
  }): Promise<UserListResponse> {
    const query = new URLSearchParams();
    if (options?.page !== undefined) query.set('page', String(options.page));
    if (options?.pageSize !== undefined) query.set('pageSize', String(options.pageSize));
    if (options?.q) query.set('q', options.q);
    if (options?.status) query.set('status', options.status);
    if (options?.groupId) query.set('groupId', options.groupId);
    if (options?.sort) query.set('sort', options.sort);
    const qs = query.toString();
    return this.get(`/admin/users${qs ? `?${qs}` : ''}`, userListResponseSchema);
  }

  /** Read the full admin user detail aggregate (wallet, services, orders, ledger). */
  getAdminUser(
    id: string,
    options?: { orderPage?: number; orderPageSize?: number },
  ): Promise<AdminUserDetailResponse> {
    const query = new URLSearchParams();
    if (options?.orderPage) query.set('orderPage', String(options.orderPage));
    if (options?.orderPageSize) query.set('orderPageSize', String(options.orderPageSize));
    return this.get(
      `/admin/users/${encodeURIComponent(id)}${query.size ? `?${query}` : ''}`,
      adminUserDetailResponseSchema,
    );
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
    input: { sourceId: string; providerServiceId: string; sourceRef?: string },
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
  getUpstreamProduct(
    providerId: string,
    productId: string,
    options?: { sourceRef?: string },
  ): Promise<UpstreamProductResponse> {
    const qs = options?.sourceRef ? `?sourceRef=${encodeURIComponent(options.sourceRef)}` : '';
    return this.get(
      `/store/upstream-products/${encodeURIComponent(providerId)}/${encodeURIComponent(productId)}${qs}`,
      upstreamProductResponseSchema,
    );
  }

  /** Read checkout configuration for a selected upstream product. */
  getUpstreamProductConfig(
    providerId: string,
    productId: string,
    options?: { sourceRef?: string },
  ): Promise<{ checkoutConfig: unknown | null }> {
    const qs = options?.sourceRef ? `?sourceRef=${encodeURIComponent(options.sourceRef)}` : '';
    return this.get(
      `/store/upstream-products/${encodeURIComponent(providerId)}/${encodeURIComponent(productId)}/config${qs}`,
      z.object({ checkoutConfig: z.unknown().nullable() }),
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
    /** Ed25519 PEM；登记后该密钥的每个请求都必须带请求签名。 */
    publicKey?: string | null;
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
      /** `null` 清除公钥，退回只凭 Bearer。 */
      publicKey?: string | null;
      expiresAt?: string | null;
    },
  ): Promise<ApiTokenUpdateResponse> {
    return this.patch(
      `/me/api-tokens/${encodeURIComponent(id)}`,
      input,
      apiTokenUpdateResponseSchema,
    );
  }

  /** 逐页 SEO 覆写列表（后台）。 */
  listSeoPages(
    options: { query?: string; page?: number; pageSize?: number } = {},
  ): Promise<SeoPageListResponse> {
    const params = new URLSearchParams();
    if (options.query) params.set('query', options.query);
    params.set('page', String(options.page ?? 1));
    params.set('pageSize', String(options.pageSize ?? 50));
    return this.get(`/admin/seo/pages?${params.toString()}`, seoPageListResponseSchema);
  }

  /** 保存一条逐页 SEO 覆写（按路径 upsert）。 */
  upsertSeoPage(input: SeoPageUpsertInput): Promise<SeoPageUpsertResponse> {
    return this.put('/admin/seo/pages', input, seoPageUpsertResponseSchema);
  }

  /** 删除一条逐页 SEO 覆写，页面回落到 provider 的元数据。 */
  deleteSeoPage(id: string): Promise<{ ok: boolean }> {
    return this.del(`/admin/seo/pages/${encodeURIComponent(id)}`, okResponseSchema);
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
  updateThemeSettings(id: string, settings: FrontendSettings, expectedVersion?: string): Promise<SettingsResponse> {
    return this.patch(
      `/admin/themes/${encodeURIComponent(id)}/settings`,
      { settings, ...(expectedVersion ? { expectedVersion } : {}) },
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

  /* ------------------------- 币种治理 ------------------------- */

  /** Public catalog of enabled currencies with display metadata. */
  getCurrencyDefinitions(): Promise<CurrencyDefinitionListResponse> {
    return this.get('/currency-definitions', currencyDefinitionListResponseSchema);
  }

  /** Admin catalog including enabled/referenced/settlement flags. */
  getAdminCurrencyDefinitions(): Promise<AdminCurrencyDefinitionListResponse> {
    return this.get('/admin/currency-definitions', adminCurrencyDefinitionListResponseSchema);
  }

  /** Enable or disable a catalog currency (referenced/settlement ones are refused). */
  setCurrencyEnabled(code: string, enabled: boolean): Promise<CurrencyDefinitionMutationResponse> {
    return this.patch(
      `/admin/currency-definitions/${encodeURIComponent(code)}`,
      { enabled },
      currencyDefinitionMutationResponseSchema,
    );
  }

  /** Read the platform settlement currency and its candidates. */
  getSettlementCurrency(): Promise<SettlementCurrencyResponse> {
    return this.get('/admin/settings/settlement-currency', settlementCurrencyResponseSchema);
  }

  /** Change the platform settlement currency after compatibility checks. */
  setSettlementCurrency(currency: string): Promise<SettlementCurrencyResponse> {
    return this.put(
      '/admin/settings/settlement-currency',
      { currency },
      settlementCurrencyResponseSchema,
    );
  }

  /** Admin FX rate list (direction, source, update time, validity). */
  getAdminCurrencyRates(): Promise<AdminFxRateListResponse> {
    return this.get('/admin/currency-rates', adminFxRateListResponseSchema);
  }

  /** Upsert an FX rate from a catalog currency to the settlement currency. */
  setCurrencyRate(input: {
    fromCurrency: string;
    toCurrency?: string;
    rate: number;
    validUntil?: string | null;
  }): Promise<AdminFxRateView> {
    return this.put('/admin/currency-rates', input, adminFxRateViewSchema);
  }

  /** Delete a configured FX rate pair. */
  deleteCurrencyRate(fromCurrency: string, toCurrency: string): Promise<{ deleted: boolean }> {
    return this.del(
      `/admin/currency-rates?fromCurrency=${encodeURIComponent(fromCurrency)}&toCurrency=${encodeURIComponent(toCurrency)}`,
      z.object({ deleted: z.boolean() }),
    );
  }

  // ---------------------------------------------------------------------------
  // Sales channels & payment methods (admin)
  // ---------------------------------------------------------------------------

  /**
   * Sales channels with their configured payment methods.
   *
   * This is the admin view: it includes disabled rows and provider `config`
   * (bank account / QR image), which the buyer-facing `/payment-methods` route
   * deliberately hides.
   */
  getAdminSalesChannels(): Promise<AdminSalesChannelListResponse> {
    return this.get('/admin/sales-channels', adminSalesChannelListResponseSchema);
  }

  /** Create a payment method bound to a sales channel. */
  createAdminPaymentMethod(input: {
    channelId: string;
    providerId: string;
    name: string;
    enabled?: boolean;
    scene?: string;
    currencies?: string[];
    config?: unknown;
    sortOrder?: number;
  }): Promise<AdminPaymentMethodMutationResponse> {
    return this.post('/admin/payment-methods', input, adminPaymentMethodMutationResponseSchema);
  }

  /** Patch a payment method (name / enabled / currencies / config / sort order). */
  updateAdminPaymentMethod(
    id: string,
    input: {
      name?: string;
      enabled?: boolean;
      scene?: string;
      currencies?: string[];
      config?: unknown;
      sortOrder?: number;
    },
  ): Promise<AdminPaymentMethodMutationResponse> {
    return this.patch(
      `/admin/payment-methods/${encodeURIComponent(id)}`,
      input,
      adminPaymentMethodMutationResponseSchema,
    );
  }

  /** Delete a payment method. Existing payments keep their snapshot. */
  deleteAdminPaymentMethod(id: string): Promise<{ deleted: boolean }> {
    return this.del(
      `/admin/payment-methods/${encodeURIComponent(id)}`,
      z.object({ deleted: z.boolean() }),
    );
  }

  /**
   * List payment records for operators, newest first.
   *
   * A manual provider (bank transfer / QR) has no `paymentUrl`, so the operator
   * confirmation is the settlement step. Without a list the record id only
   * surfaces inside a single buyer's order page, which makes "confirm receipt"
   * unreachable in practice.
   */
  listAdminPayments(query: AdminPaymentListQuery = {}): Promise<AdminPaymentListResponse> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.mode) params.set('mode', query.mode);
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    const qs = params.toString();
    return this.get(`/admin/payments${qs ? `?${qs}` : ''}`, adminPaymentListResponseSchema);
  }

  /** Confirm a manual payment as received (this settles the order). */
  confirmAdminPayment(id: string): Promise<AdminPaymentConfirmResult> {
    return this.post(
      `/admin/payments/${encodeURIComponent(id)}/confirm`,
      {},
      adminPaymentConfirmResultSchema,
    );
  }

  /** Cancel a manual payment that will never be paid. */
  cancelAdminPayment(id: string): Promise<AdminPaymentCancelResult> {
    return this.post(
      `/admin/payments/${encodeURIComponent(id)}/cancel`,
      {},
      adminPaymentCancelResultSchema,
    );
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

  /**
   * List installable plugins. The market is a built-in plugin (ADR-0020 D3), so
   * these paths are served by the `market` plugin, not the kernel.
   */
  getMarketPlugins(): Promise<MarketPluginsResponse> {
    return this.get('/market/admin/plugins', marketPluginsResponseSchema);
  }

  /** List installable themes from the application market plugin. */
  getMarketThemes(): Promise<MarketThemesResponse> {
    return this.get('/market/admin/themes', marketThemesResponseSchema);
  }

  /** Install or upgrade a plugin from the application market plugin. */
  installMarketPlugin(id: string): Promise<MarketInstallResponse> {
    return this.post(
      `/market/admin/plugins/${encodeURIComponent(id)}/install`,
      {},
      marketInstallResponseSchema,
    );
  }

  /** Install or upgrade a theme from the application market plugin. */
  installMarketTheme(id: string): Promise<MarketInstallResponse> {
    return this.post(
      `/market/admin/themes/${encodeURIComponent(id)}/install`,
      {},
      marketInstallResponseSchema,
    );
  }

  /* -------------------- 分发源配置（PLAN-github-distribution §10） -------------------- */

  /** 读取生效中的分发源配置（token 只报告是否已保存）。 */
  getDistributionSource(): Promise<DistributionSourceResponse> {
    return this.get('/admin/distribution/source', distributionSourceResponseSchema);
  }

  /** 保存分发源配置；保存后服务端立即重建目录协调器，无需重启。 */
  setDistributionSource(input: DistributionSourceInput): Promise<DistributionSourceResponse> {
    return this.put('/admin/distribution/source', input, distributionSourceResponseSchema);
  }

  /** 设置目录验签公钥；空串表示清除并回退到环境变量。 */
  setCatalogPublicKey(publicKey: string, keyId?: string): Promise<DistributionSourceResponse> {
    return this.put(
      '/admin/distribution/catalog-key',
      { publicKey, ...(keyId ? { keyId } : {}) },
      distributionSourceResponseSchema,
    );
  }

  /** 设置私有目录只读 token（加密存储，永不回显）；空串表示清除。 */
  setCatalogToken(token: string): Promise<DistributionSourceResponse> {
    return this.put('/admin/distribution/token', { token }, distributionSourceResponseSchema);
  }

  /** 立即触发一次目录刷新（受退避约束），用于改完配置后自检。 */
  refreshDistribution(): Promise<DistributionRefreshResult> {
    return this.post('/admin/distribution/refresh', {}, distributionRefreshResultSchema);
  }

  /** 重新从数据库读取配置（多副本时让本副本跟上）。 */
  reloadDistributionSource(): Promise<DistributionSourceResponse> {
    return this.post('/admin/distribution/reload', {}, distributionSourceResponseSchema);
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
