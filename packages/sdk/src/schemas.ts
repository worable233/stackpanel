import { z } from 'zod';
import type {
  AdminActionDefinition,
  AdminRouteDefinition,
  AccountRouteDefinition,
  AccountWidgetDefinition,
  PluginActionDefinition,
  FrontendDescriptor,
  FrontendPageDefinition,
  FrontendPageManifestEntry,
  FrontendSettings,
  FrontendSettingsField,
  FrontendSummary,
  SettingsResponse,
  SettingsSchemaResponse,
} from './frontend.js';
import type { PluginDependency, PluginExtensionConsumer, PluginRoleTemplate } from './plugin.js';
import type {
  AdminDashboardWidget,
  ApiTokenCreateResponse,
  ApiTokenListResponse,
  ApiTokenScopesResponse,
  ApiTokenUpdateResponse,
  ApiTokenView,
  ConnectedIdentity,
  ConnectedIdentityListResponse,
  CurrentUserResponse,
  Health,
  LoginResponse,
  MarketInstallResponse,
  MarketPackage,
  MarketPluginsResponse,
  MarketThemesResponse,
  NavItem,
  NavListResponse,
  OAuthAuthorizeResponse,
  OAuthProviderListResponse,
  PermissionCheckResponse,
  PluginFrontendsResponse,
  Readiness,
  SessionInfoResponse,
  ThemeInfo,
  ThemesResponse,
  ActiveThemeResponse,
  AdminTheme,
  AdminThemesResponse,
  ThemePatchResponse,
  AdminPlugin,
  AdminPluginsResponse,
  FrontendApplyStatusResponse,
  PluginDependencyStatus,
  PluginConsumesStatus,
  AdminDashboardWidgetsResponse,
  AdminActionsResponse,
  AuditLogEntry,
  AuditLogResponse,
  DeveloperOverviewResponse,
  ResellerDetailResponse,
  ResellerDeleteResponse,
  ResellerKeyResponse,
  ResellerListResponse,
  ResellerMutationResponse,
  ResellerView,
  WebhookDeliveryListResponse,
  WebhookDeliveryView,
  SigningResponse,
  RbacTemplateEntry,
  RbacTemplatesResponse,
  ThemePreviewMutationResponse,
  ThemePreviewResponse,
  PluginToggleResponse,
  PlatformInfoResponse,
  PlatformBrandResponse,
  User,
  UserListResponse,
  AdminUser,
  PermissionGroupInfo,
  PermissionGroupListResponse,
  PermissionGroupMutationResponse,
  PermissionInfo,
  PermissionInfoListResponse,
  AdminServiceItem,
  AdminServiceMutationResponse,
  AdminUserCreateResponse,
  AdminUserDetailResponse,
  AdminUserMutationResponse,
  AdminUserServicesResponse,
  AdminProductItem,
  AdminProductsResponse,
  AdminUpstreamServiceItem,
  AdminUserUpstreamServicesResponse,
  ImpersonateResponse,
  StoreProductTypeInfo,
  StoreProductTypeListResponse,
  UpstreamProductResponse,
  UpstreamProductsResponse,
  UpstreamSourceInfo,
  UpstreamSourceListResponse,
  WalletAdjustResponse,
} from './types.js';
import type { UpstreamProductItem } from './upstream.js';
import type { NotificationView } from './notifications.js';
import type {
  NotificationListResponse,
  NotificationMarkAllResponse,
  NotificationUnreadCountResponse,
} from './types.js';

export const roleSchema = z.enum(['ADMIN', 'USER']);
export const userStatusSchema = z.enum(['ACTIVE', 'DISABLED']);

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastLoginAt: z.string().nullable(),
}) satisfies z.ZodType<User>;

export const healthSchema = z.object({
  status: z.literal('ok'),
  uptime: z.number(),
  timestamp: z.string(),
}) satisfies z.ZodType<Health>;

export const readinessSchema = z.object({
  status: z.enum(['ready', 'degraded']),
  database: z.enum(['ok', 'unreachable']),
}) satisfies z.ZodType<Readiness>;

export const loginResponseSchema = z.object({
  token: z.string(),
  user: userSchema,
}) satisfies z.ZodType<LoginResponse>;

export const currentUserResponseSchema = z.object({
  user: userSchema,
}) satisfies z.ZodType<CurrentUserResponse>;

export const sessionInfoSchema = z.object({
  id: z.string(),
  role: z.enum(['ADMIN', 'USER']),
});

export const sessionInfoResponseSchema = z.object({
  user: sessionInfoSchema.nullable(),
}) satisfies z.ZodType<SessionInfoResponse>;

export const connectedIdentitySchema = z.object({
  id: z.string(),
  providerId: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  createdAt: z.string(),
}) satisfies z.ZodType<ConnectedIdentity>;

export const connectedIdentityListResponseSchema = z.object({
  identities: z.array(connectedIdentitySchema),
}) satisfies z.ZodType<ConnectedIdentityListResponse>;

export const userGroupMembershipSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/** Admin-list user as returned by GET /admin/users (role replaced by groups). */
export const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  groups: z.array(userGroupMembershipSchema),
  status: userStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastLoginAt: z.string().nullable(),
}) satisfies z.ZodType<AdminUser>;

export const userListResponseSchema = z.object({
  users: z.array(adminUserSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
}) satisfies z.ZodType<UserListResponse>;

export const adminServiceItemSchema = z.object({
  id: z.string(),
  productName: z.string(),
  fulfillmentType: z.string(),
  status: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  expiresAt: z.string().nullable(),
  providerId: z.string().nullable(),
  providerServiceId: z.string().nullable(),
  orderId: z.string().nullable(),
  createdAt: z.string(),
}) satisfies z.ZodType<AdminServiceItem>;

export const adminUserDetailResponseSchema = z.object({
  user: adminUserSchema,
  wallet: z.object({ balance: z.number().int(), currency: z.string() }).nullable(),
  services: z.array(adminServiceItemSchema),
  orders: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      total: z.number().int(),
      currency: z.string(),
      createdAt: z.string(),
    }),
  ),
  ledger: z.array(
    z.object({
      id: z.string(),
      amount: z.number().int(),
      currency: z.string(),
      type: z.string(),
      note: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
}) satisfies z.ZodType<AdminUserDetailResponse>;

export const adminUserMutationResponseSchema = z.object({
  user: adminUserSchema,
}) satisfies z.ZodType<AdminUserMutationResponse>;

export const adminUserCreateResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    status: userStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    lastLoginAt: z.string().nullable(),
  }),
  generatedPassword: z.string().optional(),
}) satisfies z.ZodType<AdminUserCreateResponse>;

export const adminUserServicesResponseSchema = z.object({
  services: z.array(adminServiceItemSchema),
}) satisfies z.ZodType<AdminUserServicesResponse>;

export const adminServiceMutationResponseSchema = z.object({
  service: adminServiceItemSchema,
}) satisfies z.ZodType<AdminServiceMutationResponse>;

export const walletAdjustResponseSchema = z.object({
  balance: z.number().int(),
  currency: z.string(),
}) satisfies z.ZodType<WalletAdjustResponse>;

export const impersonateResponseSchema = z.object({
  token: z.string(),
}) satisfies z.ZodType<ImpersonateResponse>;

export const adminProductItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number().int(),
  currency: z.string(),
  fulfillmentType: z.string(),
  status: z.string(),
}) satisfies z.ZodType<AdminProductItem>;

export const adminProductsResponseSchema = z.object({
  products: z.array(adminProductItemSchema),
}) satisfies z.ZodType<AdminProductsResponse>;

export const storeProductTypeInfoSchema = z.object({
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
}) satisfies z.ZodType<StoreProductTypeInfo>;

export const storeProductTypeListResponseSchema = z.object({
  types: z.array(storeProductTypeInfoSchema),
}) satisfies z.ZodType<StoreProductTypeListResponse>;

export const upstreamSourceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
}) satisfies z.ZodType<UpstreamSourceInfo>;

export const upstreamSourceListResponseSchema = z.object({
  sources: z.array(upstreamSourceInfoSchema),
}) satisfies z.ZodType<UpstreamSourceListResponse>;

export const upstreamProductItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number().int().nullable(),
  currency: z.string().optional(),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  specs: z.record(z.string(), z.unknown()).optional(),
  status: z.string().optional(),
  sourceRef: z.string().optional(),
}) satisfies z.ZodType<UpstreamProductItem>;

export const upstreamProductsResponseSchema = z.object({
  items: z.array(upstreamProductItemSchema),
}) satisfies z.ZodType<UpstreamProductsResponse>;

export const upstreamProductResponseSchema = z.object({
  item: upstreamProductItemSchema.nullable(),
}) satisfies z.ZodType<UpstreamProductResponse>;

export const adminUpstreamServiceItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  productName: z.string().nullable(),
  status: z.string().nullable(),
  statusLabel: z.string().nullable(),
  host: z.string().nullable(),
  expiresAt: z.string().nullable(),
  amount: z.number().int().nullable(),
  currency: z.string().nullable(),
  sourceId: z.string(),
  boundServiceId: z.string().nullable(),
  boundUserId: z.string().nullable(),
}) satisfies z.ZodType<AdminUpstreamServiceItem>;

export const adminUserUpstreamServicesResponseSchema = z.object({
  sources: z.array(upstreamSourceInfoSchema),
  services: z.array(adminUpstreamServiceItemSchema),
}) satisfies z.ZodType<AdminUserUpstreamServicesResponse>;

export const auditLogEntrySchema = z.object({
  id: z.string(),
  actorId: z.string().nullable(),
  action: z.string(),
  resource: z.string(),
  resourceId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  meta: z.unknown().nullable(),
  createdAt: z.string(),
}) satisfies z.ZodType<AuditLogEntry>;

export const auditLogResponseSchema = z.object({
  logs: z.array(auditLogEntrySchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
}) satisfies z.ZodType<AuditLogResponse>;

export const notificationViewSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(['info', 'active', 'success', 'error']),
  progress: z.number().int().min(0).max(100).nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<NotificationView>;

export const notificationListResponseSchema = z.object({
  items: z.array(notificationViewSchema),
  unreadCount: z.number().int(),
  nextCursor: z.string().nullable(),
}) satisfies z.ZodType<NotificationListResponse>;

export const notificationUnreadCountResponseSchema = z.object({
  unreadCount: z.number().int(),
}) satisfies z.ZodType<NotificationUnreadCountResponse>;

export const notificationMarkAllResponseSchema = z.object({
  count: z.number().int(),
}) satisfies z.ZodType<NotificationMarkAllResponse>;

export const apiTokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  ipAllowlist: z.array(z.string()),
  status: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  lastUsedIp: z.string().nullable(),
  createdAt: z.string(),
}) satisfies z.ZodType<ApiTokenView>;

export const apiTokenListResponseSchema = z.object({
  tokens: z.array(apiTokenViewSchema),
}) satisfies z.ZodType<ApiTokenListResponse>;

export const apiTokenScopesResponseSchema = z.object({
  prefix: z.string(),
  scopes: z.array(z.object({ key: z.string(), name: z.string() })),
}) satisfies z.ZodType<ApiTokenScopesResponse>;

export const apiTokenCreateResponseSchema = z.object({
  token: z.string(),
  apiToken: apiTokenViewSchema,
}) satisfies z.ZodType<ApiTokenCreateResponse>;

export const apiTokenUpdateResponseSchema = z.object({
  apiToken: apiTokenViewSchema,
}) satisfies z.ZodType<ApiTokenUpdateResponse>;

export const okResponseSchema = z.object({ ok: z.boolean() });

export const oauthAuthorizeResponseSchema = z.object({
  authorizeUrl: z.string(),
  state: z.string(),
}) satisfies z.ZodType<OAuthAuthorizeResponse>;

export const oauthProviderListResponseSchema = z.object({
  providers: z.array(z.object({ id: z.string(), name: z.string() })),
}) satisfies z.ZodType<OAuthProviderListResponse>;

export const navItemSchema = z.object({
  surface: z.enum(['public', 'account', 'admin']),
  label: z.string(),
  href: z.string(),
}) satisfies z.ZodType<NavItem>;

export const navListResponseSchema = z.object({
  items: z.array(navItemSchema),
}) satisfies z.ZodType<NavListResponse>;

export const themeInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  active: z.boolean(),
  locales: z.array(z.string()).default([]),
  assets: z
    .object({
      logo: z.string().nullable(),
      favicon: z.string().nullable(),
    })
    .nullable(),
}) satisfies z.ZodType<ThemeInfo>;

export const themesResponseSchema = z.object({
  themes: z.array(themeInfoSchema),
}) satisfies z.ZodType<ThemesResponse>;

export const activeThemeResponseSchema = z.object({
  theme: themeInfoSchema.nullable(),
}) satisfies z.ZodType<ActiveThemeResponse>;

const textFieldSchema = z.object({
  type: z.literal('text'),
  name: z.string(),
  label: z.string(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  required: z.boolean().optional(),
});

const textareaFieldSchema = z.object({
  type: z.literal('textarea'),
  name: z.string(),
  label: z.string(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  required: z.boolean().optional(),
});

const colorFieldSchema = z.object({
  type: z.literal('color'),
  name: z.string(),
  label: z.string(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  required: z.boolean().optional(),
});

const numberFieldSchema = z.object({
  type: z.literal('number'),
  name: z.string(),
  label: z.string(),
  default: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  help: z.string().optional(),
  required: z.boolean().optional(),
});

const booleanFieldSchema = z.object({
  type: z.literal('boolean'),
  name: z.string(),
  label: z.string(),
  default: z.boolean().optional(),
  help: z.string().optional(),
  required: z.boolean().optional(),
});

const optionFieldSchema = z.object({
  type: z.enum(['select', 'radio']),
  name: z.string(),
  label: z.string(),
  default: z.string().optional(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).min(1),
  help: z.string().optional(),
  required: z.boolean().optional(),
});

const settingsScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

const listFieldSchema = z.lazy(() =>
  z.object({
    type: z.literal('list'),
    name: z.string(),
    label: z.string(),
    fields: z.array(frontendSettingsFieldSchema).min(1),
    default: z.array(z.record(z.string(), settingsScalarSchema)).optional(),
    itemLabelField: z.string().optional(),
    help: z.string().optional(),
    required: z.boolean().optional(),
  }),
);

export const frontendSettingsFieldSchema = z.lazy(() =>
  z.union([
    textFieldSchema,
    textareaFieldSchema,
    colorFieldSchema,
    numberFieldSchema,
    booleanFieldSchema,
    optionFieldSchema,
    listFieldSchema,
  ]),
) as unknown as z.ZodType<FrontendSettingsField>;

export const frontendSettingsGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  fields: z.array(frontendSettingsFieldSchema),
});

export const frontendSettingsSchema = z.object({
  groups: z.array(frontendSettingsGroupSchema),
});

export const frontendPageDataRequirementSchema = z.object({
  finder: z.string().min(1),
  as: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  permission: z.string().optional(),
});

export const frontendPageSchema = z.object({
  path: z.string().min(1),
  component: z.string().min(1),
  data: z.array(frontendPageDataRequirementSchema).optional(),
  layout: z.string().optional(),
}) as z.ZodType<FrontendPageDefinition | FrontendPageManifestEntry>;

export const adminMenuSchema = z.object({
  label: z.string().min(1),
  group: z.string().optional(),
});

export const adminRouteSchema = z.object({
  path: z.string().startsWith('/').min(1),
  component: z.string().min(1),
  permission: z.string().optional(),
  data: z.array(frontendPageDataRequirementSchema).optional(),
  nav: adminMenuSchema.optional(),
}) as z.ZodType<AdminRouteDefinition>;

const pluginActionFieldSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(['string', 'integer', 'number', 'money', 'boolean', 'ids']),
  required: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().int().positive().max(65_536).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const pluginActionSchema = z.object({
  id: z.string().min(1).max(64),
  method: z.enum(['POST', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').min(1).max(512),
  permission: z.string().optional(),
  input: z.array(pluginActionFieldSchema).max(32).optional(),
  redirect: z
    .object({
      responsePath: z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/),
      external: z.boolean().optional(),
    })
    .optional(),
}) as z.ZodType<PluginActionDefinition>;

export const adminActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  permission: z.string().optional(),
  component: z.string().min(1),
}) as z.ZodType<AdminActionDefinition>;

export const accountMenuSchema = z.object({
  label: z.string().min(1),
  group: z.string().optional(),
});

export const accountRouteSchema = z.object({
  path: z.string().startsWith('/').min(1),
  component: z.string().min(1),
  permission: z.string().optional(),
  data: z.array(frontendPageDataRequirementSchema).optional(),
  nav: accountMenuSchema.optional(),
}) as z.ZodType<AccountRouteDefinition>;

export const accountWidgetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  component: z.string().min(1),
  permission: z.string().optional(),
}) as z.ZodType<AccountWidgetDefinition>;

export const frontendManifestSchema = z.object({
  version: z.string(),
  revision: z.string(),
  entry: z.string(),
  pages: z.array(frontendPageSchema).default([]),
  layouts: z.array(z.string()).default([]),
  finders: z.array(z.string()).default([]),
  adminRoutes: z.array(adminRouteSchema).default([]),
  adminActions: z.array(adminActionSchema).default([]),
  actions: z.array(pluginActionSchema).default([]),
  accountRoutes: z.array(accountRouteSchema).default([]),
  accountWidgets: z.array(accountWidgetSchema).default([]),
  files: z.array(z.string()),
  settingsSchema: frontendSettingsSchema.optional(),
});

export const frontendDescriptorSchema = z.object({
  available: z.boolean(),
  manifest: frontendManifestSchema.nullable(),
}) as z.ZodType<FrontendDescriptor>;

export const pluginFrontendDescriptorSchema = z.object({
  id: z.string(),
  manifest: frontendManifestSchema,
});

export const pluginFrontendsResponseSchema = z.object({
  plugins: z.array(pluginFrontendDescriptorSchema),
}) as z.ZodType<PluginFrontendsResponse>;

export const permissionCheckResponseSchema = z.object({
  allowed: z.boolean(),
}) satisfies z.ZodType<PermissionCheckResponse>;

export const settingsSchemaResponseSchema = z.object({
  schema: frontendSettingsSchema.nullable(),
}) as z.ZodType<SettingsSchemaResponse>;

export const frontendSettingsValueSchema = z.record(
  z.string(),
  z.record(
    z.string(),
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.record(z.string(), settingsScalarSchema)),
    ]),
  ),
) satisfies z.ZodType<FrontendSettings>;

export const settingsResponseSchema = z.object({
  settings: frontendSettingsValueSchema,
}) satisfies z.ZodType<SettingsResponse>;

export const frontendSummarySchema = z.object({
  available: z.boolean(),
  pages: z.array(frontendPageSchema).default([]),
  finders: z.array(z.string()).default([]),
  adminRoutes: z.array(adminRouteSchema).default([]),
  adminActions: z.array(adminActionSchema).default([]),
  actions: z.array(pluginActionSchema).default([]),
  accountRoutes: z.array(accountRouteSchema).default([]),
  accountWidgets: z.array(accountWidgetSchema).default([]),
  revision: z.string().nullable(),
  settingsSchema: frontendSettingsSchema.nullable(),
  locales: z.array(z.string()).default([]),
}) as z.ZodType<FrontendSummary>;

export const adminThemeSchema = themeInfoSchema.extend({
  isDefault: z.boolean(),
  installedAt: z.string(),
  updatedAt: z.string(),
  frontend: frontendSummarySchema,
  signed: z.boolean(),
}) as z.ZodType<AdminTheme>;

export const adminThemesResponseSchema = z.object({
  themes: z.array(adminThemeSchema),
}) as z.ZodType<AdminThemesResponse>;

export const themePatchResponseSchema = z.object({
  theme: themeInfoSchema,
}) satisfies z.ZodType<ThemePatchResponse>;

export const pluginRoleTemplateSchema = z.object({
  role: z.enum(['ADMIN', 'USER']),
  permissions: z.array(z.string()),
}) satisfies z.ZodType<PluginRoleTemplate>;

export const pluginDependencySchema = z.object({
  id: z.string(),
  range: z.string().optional(),
  optional: z.boolean().optional(),
}) as z.ZodType<PluginDependency>;

export const pluginExtensionConsumerSchema = z.object({
  pluginId: z.string(),
  extensionPoint: z.string(),
  optional: z.boolean().optional(),
}) as z.ZodType<PluginExtensionConsumer>;

export const pluginDependencyStatusSchema = z.object({
  id: z.string(),
  range: z.string().nullable(),
  optional: z.boolean(),
  installed: z.boolean(),
  version: z.string().nullable(),
  satisfied: z.boolean(),
}) as z.ZodType<PluginDependencyStatus>;

export const pluginConsumesStatusSchema = z.object({
  pluginId: z.string(),
  extensionPoint: z.string(),
  optional: z.boolean(),
  satisfied: z.boolean(),
}) as z.ZodType<PluginConsumesStatus>;

export const adminPluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  version: z.string(),
  state: z.string(),
  enabled: z.boolean(),
  source: z.enum(['builtin', 'dynamic']),
  hotReload: z.boolean(),
  frontend: frontendSummarySchema,
  requires: z.array(pluginDependencySchema),
  dependencies: z.array(pluginDependencyStatusSchema),
  provides: z.array(z.string()),
  consumes: z.array(pluginExtensionConsumerSchema),
  consumesStatus: z.array(pluginConsumesStatusSchema),
  permissions: z.array(z.string()),
  roleTemplates: z.array(pluginRoleTemplateSchema),
  locales: z.array(z.string()).default([]),
  signed: z.boolean(),
}) as z.ZodType<AdminPlugin>;

export const frontendAuditResponseSchema = z.object({
  ok: z.boolean(),
});

export const adminPluginsResponseSchema = z.object({
  plugins: z.array(adminPluginSchema),
}) as z.ZodType<AdminPluginsResponse>;

export const frontendApplyStatusSchema = z.object({
  state: z.enum(['pending', 'building', 'restarting', 'succeeded', 'failed']),
  at: z.string(),
  requestedAt: z.string().nullable(),
  label: z.string().optional(),
  target: z.enum(['plugin', 'theme']).optional(),
  action: z.enum(['install', 'update', 'remove']).optional(),
  step: z.number().optional(),
  steps: z.array(z.string()).optional(),
  detail: z.string().optional(),
  message: z.string().optional(),
});

export const frontendApplyStatusResponseSchema = z.object({
  status: frontendApplyStatusSchema.nullable(),
}) as z.ZodType<FrontendApplyStatusResponse>;

export const pluginToggleResponseSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
}) satisfies z.ZodType<PluginToggleResponse>;

export const signingStatusSchema = z.object({
  source: z.enum(['env', 'stored', 'disabled']),
  configured: z.boolean(),
  fingerprint: z.string().nullable(),
  publicKey: z.string().nullable(),
}) satisfies z.ZodType<SigningResponse['signing']>;

export const signingResponseSchema = z.object({
  signing: signingStatusSchema,
}) satisfies z.ZodType<SigningResponse>;

export const platformInfoSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(280),
  url: z.string().url().nullable(),
});

export const platformInfoResponseSchema = z.object({
  platform: platformInfoSchema,
}) satisfies z.ZodType<PlatformInfoResponse>;

export const platformBrandSchema = z.object({
  logo: z.string().nullable(),
  favicon: z.string().nullable(),
});

export const platformBrandResponseSchema = z.object({
  brand: platformBrandSchema,
}) satisfies z.ZodType<PlatformBrandResponse>;

export const adminDashboardWidgetSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  pluginId: z.string(),
}) as z.ZodType<AdminDashboardWidget>;

export const adminDashboardWidgetsResponseSchema = z.object({
  widgets: z.array(adminDashboardWidgetSchema),
}) as z.ZodType<AdminDashboardWidgetsResponse>;

export const adminActionsResponseSchema = z.object({
  actions: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      permission: z.string().optional(),
      component: z.string(),
      pluginId: z.string(),
    }),
  ),
}) as z.ZodType<AdminActionsResponse>;

export const themePreviewResponseSchema = z.object({
  themeId: z.string().nullable(),
}) satisfies z.ZodType<ThemePreviewResponse>;

export const themePreviewMutationResponseSchema = z.object({
  themeId: z.string(),
}) satisfies z.ZodType<ThemePreviewMutationResponse>;

export const rbacTemplateEntrySchema = z.object({
  pluginId: z.string(),
  permission: z.string(),
}) satisfies z.ZodType<RbacTemplateEntry>;

export const rbacTemplatesResponseSchema = z.object({
  templates: z.array(rbacTemplateEntrySchema),
}) satisfies z.ZodType<RbacTemplatesResponse>;

export const permissionInfoSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
}) satisfies z.ZodType<PermissionInfo>;

export const permissionListSchema = z.object({
  permissions: z.array(permissionInfoSchema),
}) satisfies z.ZodType<PermissionInfoListResponse>;

export const permissionGroupInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  discount: z.number().int().min(0).max(99).nullable(),
}) satisfies z.ZodType<PermissionGroupInfo>;

export const permissionGroupViewSchema = permissionGroupInfoSchema.extend({
  permissions: z.array(z.object({ key: z.string(), name: z.string(), description: z.string().nullable() })),
  memberCount: z.number(),
  structural: z.boolean(),
});

export const permissionGroupListSchema = z.object({
  groups: z.array(permissionGroupViewSchema),
}) satisfies z.ZodType<PermissionGroupListResponse>;

export const permissionGroupCreateSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(191).optional(),
  discount: z.number().int().min(0).max(99).nullable().optional(),
});

export const permissionGroupUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(191).optional(),
  permissionKeys: z.array(z.string().min(1)).optional(),
  discount: z.number().int().min(0).max(99).nullable().optional(),
});

export const permissionGroupMutationResponseSchema = z.object({
  group: permissionGroupInfoSchema,
}) satisfies z.ZodType<PermissionGroupMutationResponse>;

export const permissionGroupPatchResponseSchema = z.object({
  updated: z.boolean(),
});

export const permissionGroupDeleteResponseSchema = z.object({
  deleted: z.boolean(),
});

export const marketPackageSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  kind: z.enum(['plugin', 'theme']),
  installed: z.boolean(),
  installedVersion: z.string().nullable().optional(),
  upgradable: z.boolean(),
  current: z.boolean(),
  builtin: z.boolean(),
  frontend: z
    .object({
      available: z.boolean(),
      pages: z.array(z.object({ path: z.string(), component: z.string() })),
      finders: z.array(z.string()),
    })
    .optional(),
}) as z.ZodType<MarketPackage>;

export const marketPluginsResponseSchema = z.object({
  plugins: z.array(marketPackageSchema),
}) as z.ZodType<MarketPluginsResponse>;

export const marketThemesResponseSchema = z.object({
  themes: z.array(marketPackageSchema),
}) as z.ZodType<MarketThemesResponse>;

export const marketInstallResponseSchema = z.object({
  installed: z.boolean(),
  upgraded: z.boolean(),
  id: z.string(),
  version: z.string(),
}) as z.ZodType<MarketInstallResponse>;

/* -------------------- 开发者控制台（DEV-CONSOLE P4） -------------------- */

export const resellerViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  keyId: z.string(),
  publicKey: z.string(),
  hasWebhookKey: z.boolean(),
  webhookPublicKey: z.string().nullable(),
  webhookUrl: z.string().nullable(),
  scopes: z.array(z.string()),
  rateLimitRpm: z.number(),
  lastUsedAt: z.string().nullable(),
  lastUsedIp: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<ResellerView>;

export const resellerListResponseSchema = z.object({
  resellers: z.array(resellerViewSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
}) satisfies z.ZodType<ResellerListResponse>;

export const webhookDeliveryViewSchema = z.object({
  id: z.string(),
  resellerId: z.string(),
  resellerName: z.string().nullable(),
  event: z.string(),
  url: z.string(),
  status: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  responseCode: z.number().nullable(),
  error: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<WebhookDeliveryView>;

export const webhookDeliveryListResponseSchema = z.object({
  deliveries: z.array(webhookDeliveryViewSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
}) satisfies z.ZodType<WebhookDeliveryListResponse>;

export const resellerDetailResponseSchema = z.object({
  reseller: resellerViewSchema,
  deliveries: z.array(webhookDeliveryViewSchema),
}) satisfies z.ZodType<ResellerDetailResponse>;

export const developerOverviewResponseSchema = z.object({
  overview: z.object({
    resellers: z.object({ total: z.number(), active: z.number() }),
    webhookDeliveries: z.object({
      pending: z.number(),
      failed: z.number(),
      succeeded: z.number(),
    }),
    calls: z.object({ last24h: z.number(), total: z.number() }),
  }),
}) satisfies z.ZodType<DeveloperOverviewResponse>;

/* ---------------- 开发者控制台写端点（CONSOLE-WRITE） ---------------- */

/** 渠道可授予的能力 scope（与 `/sp/v1` 一致，值与 `DeveloperSpScope` 保持同步）。 */
export const DEVELOPER_SP_SCOPES = [
  'catalog:read',
  'order:read',
  'order:write',
  'service:read',
  'service:write',
] as const;

export const resellerKeyResponseSchema = z.object({
  reseller: resellerViewSchema,
  inboundPrivateKey: z.string(),
}) satisfies z.ZodType<ResellerKeyResponse>;

export const resellerMutationResponseSchema = z.object({
  reseller: resellerViewSchema,
}) satisfies z.ZodType<ResellerMutationResponse>;

export const resellerDeleteResponseSchema = z.object({
  deleted: z.boolean(),
}) satisfies z.ZodType<ResellerDeleteResponse>;
