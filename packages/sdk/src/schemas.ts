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
  FrontendSettingsValue,
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
  AdminCurrencyDefinitionListResponse,
  AdminCurrencyDefinitionView,
  AdminFxRateListResponse,
  AdminFxRateView,
  AdminPaymentMethod,
  AdminPaymentMethodMutationResponse,
  AdminSalesChannel,
  AdminSalesChannelListResponse,
  ConnectedIdentity,
  ConnectedIdentityListResponse,
  AccountMutationResponse,
  CurrencyDefinitionListResponse,
  CurrencyDefinitionMutationResponse,
  CurrencyDefinitionView,
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
  SettlementCurrencyResponse,
  SetupStatusResponse,
  ThemeInfo,
  ThemesResponse,
  ActiveThemeResponse,
  AdminTheme,
  AdminThemesResponse,
  ThemePatchResponse,
  AdminPlugin,
  AdminPluginsResponse,
  FrontendApplyStatusResponse,
  UpdateStatusResponse,
  UpdatePolicyView,
  UpdatePlanResponse,
  UpdateSubmitResponse,
  UpdateCatalogView,
  UpdateTaskResultView,
  UpdateCheckResponse,
  UpdateResultResponse,
  UpdateResultsResponse,
  UpdateSelfUpdateResponse,
  UpdateSelfUpdateSubmitResponse,
  UpdateSelfUpdateCancelResponse,
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
  AuthConfigResponse,
  SendRegisterCodeResponse,
} from './types.js';
import type { UpstreamProductItem } from './upstream.js';
import type { ProductConfigField } from './fulfillment.js';
import type { NotificationView } from './notifications.js';
import type { DistributionRefreshResult, DistributionSourceResponse } from './market.js';
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
  // Tolerance for responses minted before this field existed; the API always
  // sends it now, but the BFF must not fail parsing an older replica's reply.
  emailVerifiedAt: z.string().nullable().default(null),
}) satisfies z.ZodType<User>;

export const authConfigResponseSchema = z.object({
  registrationMethods: z.array(z.enum(['email', 'phone'])),
  emailVerificationSupported: z.boolean(),
  emailVerificationRequired: z.boolean(),
  captcha: z.object({
    mode: z.enum(['off', 'optional', 'required']),
    configured: z.boolean(),
    providerIds: z.array(z.string()),
    clientConfig: z.record(z.string(), z.unknown()).nullable(),
  }),
}) satisfies z.ZodType<AuthConfigResponse>;

export const sendRegisterCodeResponseSchema = z.object({
  sent: z.boolean(),
  email: z.string(),
  expiresAt: z.string(),
  expiresInSeconds: z.number(),
}) satisfies z.ZodType<SendRegisterCodeResponse>;

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

export const accountMutationResponseSchema = z.object({
  ok: z.literal(true),
}) satisfies z.ZodType<AccountMutationResponse>;

export const sessionInfoResponseSchema = z.object({
  user: sessionInfoSchema.nullable(),
}) satisfies z.ZodType<SessionInfoResponse>;

/** `POST /setup/provision` response: the queued operation projection. */
export const bootstrapProvisionResponseSchema = z.object({
  operation: z.object({
    id: z.string(),
    configGeneration: z.number().int(),
    targetVersion: z.string(),
    phase: z.string(),
    failure: z.string().optional(),
    diagnosticsRequired: z.boolean().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
});

export const setupStatusResponseSchema = z.object({
  required: z.boolean(),
  tokenRequired: z.boolean(),
  phase: z.enum([
    'needs_infra',
    'validating',
    'queued',
    'migrating',
    'migration_failed',
    'starting',
    'runtime_failed',
    'needs_admin',
    'complete',
  ]),
  operation: z
    .object({
      id: z.string(),
      configGeneration: z.number().int(),
      targetVersion: z.string(),
      phase: z.string(),
      failure: z.string().optional(),
      diagnosticsRequired: z.boolean().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .optional(),
}) satisfies z.ZodType<SetupStatusResponse>;

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
  balance: z.number().int().optional(),
  balanceCurrency: z.string().optional(),
  serviceCount: z.number().int().nonnegative().nullable().optional(),
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
  ordersPagination: z
    .object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int() })
    .optional(),
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

const productConfigVisibilitySchema = z.object({
  field: z.string(),
  equals: z.unknown().optional(),
  in: z.array(z.unknown()).optional(),
});

/** Recursive: a config field may nest children (group / repeat). */
const productConfigFieldSchema: z.ZodType<ProductConfigField> = z.lazy(() =>
  z.object({
    name: z.string(),
    label: z.string(),
    type: z.enum([
      'text',
      'textarea',
      'number',
      'select',
      'multiselect',
      'boolean',
      'tags',
      'json',
      'group',
      'repeat',
    ]),
    required: z.boolean().optional(),
    placeholder: z.string().optional(),
    help: z.string().optional(),
    defaultValue: z.unknown().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    maxLength: z.number().optional(),
    options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    optionsSource: z.literal('permissionGroups').optional(),
    visibleWhen: productConfigVisibilitySchema.optional(),
    group: z.string().optional(),
    columns: z.union([z.literal(1), z.literal(2)]).optional(),
    fields: z.array(productConfigFieldSchema).optional(),
    itemLabel: z.string().optional(),
  }),
);

export const storeProductTypeInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  pluginId: z.string(),
  configFields: z.array(productConfigFieldSchema),
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
  sourceRef: z.string().nullable().optional(),
  productId: z.string().nullable().optional(),
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
  label: z.string().optional(),
  labelKey: z.string().min(1).max(160).optional(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  placeholderKey: z.string().min(1).max(160).optional(),
  help: z.string().optional(),
  helpKey: z.string().min(1).max(160).optional(),
  required: z.boolean().optional(),
});

const textareaFieldSchema = z.object({
  type: z.literal('textarea'),
  name: z.string(),
  label: z.string().optional(),
  labelKey: z.string().min(1).max(160).optional(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  placeholderKey: z.string().min(1).max(160).optional(),
  help: z.string().optional(),
  helpKey: z.string().min(1).max(160).optional(),
  required: z.boolean().optional(),
});

const colorFieldSchema = z.object({
  type: z.literal('color'),
  name: z.string(),
  label: z.string().optional(),
  labelKey: z.string().min(1).max(160).optional(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  placeholderKey: z.string().min(1).max(160).optional(),
  help: z.string().optional(),
  helpKey: z.string().min(1).max(160).optional(),
  required: z.boolean().optional(),
});

const numberFieldSchema = z.object({
  type: z.literal('number'),
  name: z.string(),
  label: z.string().optional(),
  labelKey: z.string().min(1).max(160).optional(),
  default: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  help: z.string().optional(),
  helpKey: z.string().min(1).max(160).optional(),
  required: z.boolean().optional(),
});

const booleanFieldSchema = z.object({
  type: z.literal('boolean'),
  name: z.string(),
  label: z.string().optional(),
  labelKey: z.string().min(1).max(160).optional(),
  default: z.boolean().optional(),
  help: z.string().optional(),
  helpKey: z.string().min(1).max(160).optional(),
  required: z.boolean().optional(),
});

const optionFieldSchema = z.object({
  type: z.enum(['select', 'radio']),
  name: z.string(),
  label: z.string().optional(),
  labelKey: z.string().min(1).max(160).optional(),
  default: z.string().optional(),
  options: z
    .array(
      z.object({
        label: z.string().optional(),
        labelKey: z.string().min(1).max(160).optional(),
        value: z.string(),
      }),
    )
    .min(1),
  help: z.string().optional(),
  helpKey: z.string().min(1).max(160).optional(),
  required: z.boolean().optional(),
});

const settingsScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const settingsFieldValueSchema: z.ZodType<FrontendSettingsValue> = z.lazy(() =>
  z.union([settingsScalarSchema, z.array(z.record(z.string(), settingsFieldValueSchema))]),
);

const listFieldSchema = z.lazy(() =>
  z.object({
    type: z.literal('list'),
    name: z.string(),
    label: z.string().optional(),
    labelKey: z.string().min(1).max(160).optional(),
    fields: z.array(frontendSettingsFieldSchema).min(1),
    default: z.array(z.record(z.string(), settingsFieldValueSchema)).optional(),
    migrateFrom: z.union([z.string(), z.array(z.record(z.string(), z.string()))]).optional(),
    itemLabelField: z.string().optional(),
    help: z.string().optional(),
    helpKey: z.string().min(1).max(160).optional(),
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
  label: z.string().optional(),
  labelKey: z.string().min(1).max(160).optional(),
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
  label: z.string().min(1).optional(),
  labelKey: z.string().min(1).max(160).optional(),
  order: z.number().finite().optional(),
  activePaths: z.array(z.string().startsWith('/')).optional(),
  group: z.string().optional(),
  groupKey: z.string().min(1).max(160).optional(),
});

export const adminRouteSchema = z.object({
  systemSettings: z
    .object({
      label: z.string().min(1).max(80).optional(),
      labelKey: z.string().min(1).max(160).optional(),
      order: z.number().finite().optional(),
    })
    .optional(),
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
  successFeedback: z
    .object({
      message: z.string().trim().min(1).max(256).optional(),
      messageKey: z.string().min(1).max(160).optional(),
      params: z
        .record(
          z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
          z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/),
        )
        .refine((params) => Object.keys(params).length <= 8, {
          message: 'successFeedback.params 最多 8 个字段',
        })
        .optional(),
    })
    .refine((feedback) => Boolean(feedback.message || feedback.messageKey), {
      message: 'successFeedback 需要 message 或 messageKey',
    })
    .optional(),
  silent: z.boolean().optional(),
}) as z.ZodType<PluginActionDefinition>;

export const adminActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  permission: z.string().optional(),
  component: z.string().min(1),
}) as z.ZodType<AdminActionDefinition>;

export const accountMenuSchema = z.object({
  label: z.string().min(1).optional(),
  labelKey: z.string().min(1).max(160).optional(),
  order: z.number().finite().optional(),
  activePaths: z.array(z.string().startsWith('/')).optional(),
  group: z.string().optional(),
  groupKey: z.string().min(1).max(160).optional(),
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
  title: z.string().min(1).optional(),
  titleKey: z.string().min(1).max(160).optional(),
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
  // Contract 05 §3.2: pre-compiled CSS the package ships, each a path relative
  // to the frontend package root (e.g. `frontend/dist/<id>.css`). Distinct from
  // the theme token channel (`theme.css`).
  styles: z.array(z.string()).default([]),
  settingsSchema: frontendSettingsSchema.optional(),
  /**
   * ADR-0016 §5: the package's serialized catalogs and declared locales.
   *
   * These must survive manifest validation — the host resolves nav / settings /
   * widget labels from them without importing the package. Bound them here so a
   * hostile manifest cannot smuggle an unbounded object into every request.
   */
  locales: z.array(z.string().min(1).max(35)).max(16).optional(),
  messages: z
    .record(
      z.string().min(1).max(35),
      z
        .record(z.string().min(1).max(160), z.string().max(4000))
        .refine((catalog) => Object.keys(catalog).length <= 4000, {
          message: 'message catalog exceeds key limit',
        }),
    )
    .refine((catalogs) => Object.keys(catalogs).length <= 16, {
      message: 'too many message locales',
    })
    .optional(),
});

export const frontendDescriptorSchema = z.object({
  available: z.boolean(),
  manifest: frontendManifestSchema.nullable(),
  revision: z.string().optional(),
}) as z.ZodType<FrontendDescriptor>;

export const pluginFrontendDescriptorSchema = z.object({
  id: z.string(),
  manifest: frontendManifestSchema,
  builtin: z.boolean(),
  execution: z.enum(['trusted', 'isolated']),
  serverExecution: z.enum(['allowed', 'declarative']),
  revision: z.string().optional(),
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
  z.record(z.string(), settingsFieldValueSchema),
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

const updatePolicyViewSchema = z.object({
  autoUpdate: z.boolean(),
  channel: z.enum(['stable', 'beta']),
  autoUpdateKernel: z.boolean(),
  excluded: z.array(z.string()),
  pinned: z.record(z.string(), z.string()),
  maintenanceWindow: z.object({ startHour: z.number(), endHour: z.number() }).optional(),
  allowPermissionIncrease: z.boolean(),
  allowIrreversibleMigration: z.boolean(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().nullable().optional(),
});

const updateBlockReasonSchema = z.object({
  code: z.string(),
  detail: z.string(),
  component: z.object({ kind: z.string(), id: z.string() }).optional(),
});

/** 升级任务结果投影（`UpdateTaskResult` 的宽松视图：未知字段不报错，避免协议演进而卡死页面）。 */
const updateCheckpointViewSchema = z.object({
  phase: z.string(),
  at: z.string(),
  inputDigest: z.string(),
  credential: z.string().optional(),
});

const updateRecoveryViewSchema = z.object({
  recovered: z.boolean(),
  backupRef: z.string().optional(),
  detail: z.string(),
});

const updateTaskResultViewSchema = z.object({
  phase: z.string(),
  checkpoints: z.array(updateCheckpointViewSchema).optional(),
  block: updateBlockReasonSchema.optional(),
  recovery: updateRecoveryViewSchema.optional(),
});

const updateCatalogFailureSchema = z.object({
  kind: z.string(),
  message: z.string(),
  retryAt: z.string().nullable(),
});

export const updateCatalogViewSchema = z.object({
  state: z.enum(['unconfigured', 'pending', 'ready', 'failed']),
  repository: z.string().nullable(),
  channel: z.enum(['stable', 'beta']).nullable(),
  sequence: z.number().nullable(),
  generatedAt: z.string().nullable(),
  expired: z.boolean().nullable(),
  failure: updateCatalogFailureSchema.nullable(),
  lastCheckedAt: z.string().nullable(),
  cooldownMs: z.number(),
}) as unknown as z.ZodType<UpdateCatalogView>;

export const updateStatusResponseSchema = z.object({
  status: z
    .object({
      generation: z.number(),
      digest: z.string().nullable(),
      activeTask: z.string().nullable(),
      recent: z.array(
        z.object({ idempotencyKey: z.string(), result: updateTaskResultViewSchema }),
      ),
      updatedAt: z.string(),
    })
    .nullable(),
  policy: updatePolicyViewSchema,
  catalogState: z.enum(['unconfigured', 'pending', 'ready', 'failed']),
  catalogConfigured: z.boolean(),
  catalogExpired: z.boolean().nullable(),
  catalogFailure: updateCatalogFailureSchema.nullable(),
  catalogRepository: z.string().nullable(),
  catalogChannel: z.enum(['stable', 'beta']).nullable(),
  catalogSequence: z.number().nullable(),
  catalogGeneratedAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  cooldownMs: z.number(),
  carrier: z.string(),
  instanceId: z.string(),
}) as unknown as z.ZodType<UpdateStatusResponse>;

export const updatePolicyResponseSchema = z.object({
  policy: updatePolicyViewSchema,
}) as unknown as z.ZodType<{ policy: UpdatePolicyView }>;

export const updatePlanResponseSchema = z.object({
  ok: z.boolean(),
  blocks: z.array(updateBlockReasonSchema).optional(),
  catalogExpired: z.boolean().optional(),
  planDigest: z.string().optional(),
  plan: z
    .object({
      kernel: z.object({ version: z.string(), digest: z.string(), migration: z.string() }),
      packages: z.array(
        z.object({
          kind: z.enum(['plugin', 'theme']),
          id: z.string(),
          fromVersion: z.string().nullable(),
          toVersion: z.string(),
          revision: z.string(),
          addsPermissions: z.boolean(),
          reversible: z.boolean(),
        }),
      ),
    })
    .optional(),
  includesKernel: z.boolean().optional(),
  task: z
    .object({
      instanceId: z.string(),
      baselineGeneration: z.number(),
      targetDigest: z.string(),
      idempotencyKey: z.string(),
    })
    .optional(),
  requiresAuthorization: z.boolean().optional(),
}) as unknown as z.ZodType<UpdatePlanResponse>;

export const updateSubmitResponseSchema = z.object({
  submitted: z.boolean(),
  idempotencyKey: z.string(),
  planDigest: z.string(),
  catalogExpired: z.boolean().optional(),
}) as unknown as z.ZodType<UpdateSubmitResponse>;

export const updateResultsResponseSchema = z.object({
  results: z.array(z.object({ idempotencyKey: z.string(), result: updateTaskResultViewSchema })),
}) as unknown as z.ZodType<UpdateResultsResponse>;

export const updateResultResponseSchema = z.object({
  result: updateTaskResultViewSchema,
}) as unknown as z.ZodType<UpdateResultResponse>;

export const updateCheckResponseSchema = z.object({
  checked: z.boolean(),
  throttled: z.boolean(),
  retryAtMs: z.number(),
  catalog: updateCatalogViewSchema,
  plan: updatePlanResponseSchema.nullable(),
}) as unknown as z.ZodType<UpdateCheckResponse>;

const updateSelfUpdateRequestViewSchema = z.object({
  candidateDigest: z.string(),
  requestedBy: z.string(),
  requestedAt: z.string(),
});

export const updateSelfUpdateResponseSchema = z.object({
  request: updateSelfUpdateRequestViewSchema.nullable(),
}) as unknown as z.ZodType<UpdateSelfUpdateResponse>;

export const updateSelfUpdateSubmitResponseSchema = z.object({
  submitted: z.boolean(),
  request: updateSelfUpdateRequestViewSchema,
}) as unknown as z.ZodType<UpdateSelfUpdateSubmitResponse>;

export const updateSelfUpdateCancelResponseSchema = z.object({
  cleared: z.boolean(),
}) as unknown as z.ZodType<UpdateSelfUpdateCancelResponse>;

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
  permissions: z.array(
    z.object({ key: z.string(), name: z.string(), description: z.string().nullable() }),
  ),
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

/* -------------------- 分发源配置（PLAN-github-distribution §2/§10） -------------------- */

export const distributionSourceConfigSchema = z.object({
  repository: z.string().nullable(),
  channel: z.enum(['stable', 'beta']),
  ref: z.string(),
  mirror: z.string().nullable(),
  publicKey: z.string().nullable(),
  publicKeyId: z.string().nullable(),
  tokenConfigured: z.boolean(),
  source: z.enum(['stored', 'env']),
  envRepository: z.string().nullable(),
  envMirror: z.string().nullable(),
  secretsEnabled: z.boolean(),
}) satisfies z.ZodType<DistributionSourceResponse['source']>;

export const distributionSourceResponseSchema = z.object({
  source: distributionSourceConfigSchema,
  defaults: z
    .object({ repository: z.string().nullable(), mirror: z.string().nullable() })
    .optional(),
}) satisfies z.ZodType<DistributionSourceResponse>;

const distributionFailureSchema = z.object({
  kind: z.string(),
  message: z.string(),
  retryAt: z.string().optional(),
});

export const distributionRefreshResultSchema = z.object({
  configured: z.boolean(),
  available: z.boolean(),
  throttled: z.boolean().optional(),
  retryAtMs: z.number().optional(),
  failure: distributionFailureSchema.nullable(),
  sequence: z.number().nullable().optional(),
  expired: z.boolean().nullable().optional(),
}) satisfies z.ZodType<DistributionRefreshResult>;

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

/* ----------------------------- 币种治理 ----------------------------- */

export const currencyDefinitionViewSchema = z.object({
  code: z.string(),
  name: z.string(),
  symbol: z.string(),
  minorUnit: z.number().int(),
}) satisfies z.ZodType<CurrencyDefinitionView>;

export const currencyDefinitionListResponseSchema = z.object({
  currencies: z.array(currencyDefinitionViewSchema),
}) satisfies z.ZodType<CurrencyDefinitionListResponse>;

export const adminCurrencyDefinitionViewSchema = currencyDefinitionViewSchema.extend({
  enabled: z.boolean(),
  referenced: z.boolean(),
  settlement: z.boolean(),
  sample: z.string(),
}) satisfies z.ZodType<AdminCurrencyDefinitionView>;

export const adminCurrencyDefinitionListResponseSchema = z.object({
  currencies: z.array(adminCurrencyDefinitionViewSchema),
  settlementCurrency: z.string(),
}) satisfies z.ZodType<AdminCurrencyDefinitionListResponse>;

export const currencyDefinitionMutationResponseSchema = z.object({
  currency: adminCurrencyDefinitionViewSchema,
}) satisfies z.ZodType<CurrencyDefinitionMutationResponse>;

export const settlementCurrencyResponseSchema = z.object({
  settlementCurrency: z.string(),
  candidates: z.array(currencyDefinitionViewSchema).optional(),
}) satisfies z.ZodType<SettlementCurrencyResponse>;

export const adminFxRateViewSchema = z.object({
  id: z.string(),
  fromCurrency: z.string(),
  toCurrency: z.string(),
  rate: z.number().int(),
  source: z.string(),
  validUntil: z.string().nullable(),
  updatedAt: z.string(),
}) satisfies z.ZodType<AdminFxRateView>;

export const adminFxRateListResponseSchema = z.object({
  settlementCurrency: z.string(),
  rates: z.array(adminFxRateViewSchema),
}) satisfies z.ZodType<AdminFxRateListResponse>;

export const adminPaymentMethodSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  providerId: z.string(),
  // `.default(null)` (not `.optional()`) so the output type stays free of
  // `undefined`, which `exactOptionalPropertyTypes` refuses on optional props.
  providerMode: z.enum(['gateway', 'manual']).nullable().default(null),
  name: z.string(),
  enabled: z.boolean(),
  scene: z.string(),
  currencies: z.array(z.string()),
  config: z.unknown(),
  sortOrder: z.number(),
  createdAt: z.string(),
}) satisfies z.ZodType<AdminPaymentMethod>;

export const adminSalesChannelSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  terminal: z.string(),
  enabled: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.string(),
  methods: z.array(adminPaymentMethodSchema),
}) satisfies z.ZodType<AdminSalesChannel>;

export const adminSalesChannelListResponseSchema = z.object({
  channels: z.array(adminSalesChannelSchema),
  providers: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        mode: z.enum(['gateway', 'manual']),
        methods: z.array(z.object({ id: z.string(), label: z.string() })),
      }),
    )
    .default([]),
}) satisfies z.ZodType<AdminSalesChannelListResponse>;

export const adminPaymentMethodMutationResponseSchema = z.object({
  method: adminPaymentMethodSchema,
}) satisfies z.ZodType<AdminPaymentMethodMutationResponse>;
