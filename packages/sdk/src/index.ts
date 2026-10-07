export { ApiClient } from './client.js';
export type { ApiClientOptions } from './client.js';
export {
  ApiError,
  KernelError,
  PluginError,
  isPluginError,
  type BrandedPluginError,
} from './errors.js';
export type { FieldError, ProblemDetails } from './errors.js';
// `isSafeUrl` is pure and safe for client bundles. The full rich-text sanitizer
// lives behind the `@stackpanel/sdk/sanitize` subpath because it depends on the
// server-only `sanitize-html` parser (SECURITY-AUDIT-2026-10-04 I-1).
export { isSafeUrl } from './url-safety.js';
export { definePlugin } from './plugin.js';
export { normalizePluginDependencies, normalizePluginPermissions } from './plugin.js';
export { DisposableList, disposeAll, runEffect } from './effect.js';
export type { Disposable, EffectResult } from './effect.js';
export type {
  FulfillmentProvider,
  FulfillmentType,
  MetricPoint,
  MetricSeries,
  ProductConfigField,
  ProductTypeProvider,
  ProvisionContext,
  ProvisionResult,
  ProviderServiceContext,
  ServiceAction,
  ServiceDetail,
  ServiceDetailField,
  ServiceStatus,
} from './fulfillment.js';
export type {
  CheckoutBillingCycle,
  CheckoutConfigOption,
  CheckoutConfigSchema,
  CheckoutOptionChoice,
  CheckoutPriceContext,
  CheckoutPriceResult,
  CheckoutSelection,
} from './fulfillment.js';
export { computeCheckoutPrice, readCheckoutConfig } from './fulfillment.js';
export type {
  UpstreamProductItem,
  UpstreamProductSource,
  UpstreamServiceItem,
  UpstreamServiceSource,
} from './upstream.js';
export type {
  CreateNotificationInput,
  NotificationListResult,
  NotificationStatus,
  NotificationView,
  NotificationsService,
  UpsertNotificationInput,
} from './notifications.js';
export {
  buildZodFromSettingsSchema,
  captureFrontendPathParams,
  defineFrontend,
  matchFrontendPagePath,
  mergeFrontendSettings,
  resolveFrontendPageSource,
  resolveThemeOverride,
  selectFrontendPageDefinition,
  settingsDefaultsFromSchema,
} from './frontend.js';
export type {
  AdminActionComponent,
  AdminActionComponentProps,
  AdminActionDefinition,
  AccountMenuDefinition,
  AccountPageComponent,
  AccountPageComponentProps,
  AccountRouteDefinition,
  AccountUser,
  AccountWidgetComponent,
  AccountWidgetDefinition,
  AccountWidgetProps,
  AdminDashboardWidgetMeta,
  AdminMenuDefinition,
  AdminPageComponent,
  AdminPageComponentProps,
  AdminRouteDefinition,
  AdminWidgetProps,
  FinderContext,
  FinderProvider,
  FinderSession,
  FrontendDescriptor,
  FrontendLayoutComponent,
  FrontendLayoutProps,
  FrontendNavigationItem,
  FrontendActionExecutor,
  FrontendActionExecutors,
  FrontendPageComponent,
  FrontendPageDataRequirement,
  FrontendPageDefinition,
  FrontendPageManifestEntry,
  FrontendPageProps,
  FrontendPageSource,
  FrontendManifest,
  FrontendPackage,
  FrontendSettings,
  FrontendSettingsField,
  FrontendSettingsGroup,
  FrontendSettingsListItem,
  FrontendSettingsScalar,
  FrontendSettingsScalarField,
  FrontendSettingsSchema,
  FrontendSettingsValue,
  FrontendSummary,
  PluginActionDefinition,
  PluginActionInputField,
  PluginActionRedirect,
  SettingsResponse,
  SettingsSchemaResponse,
} from './frontend.js';
export type {
  AuthIdentity,
  AuthProvider,
  ExternalPaymentInitiation,
  ExternalPaymentInitiationResult,
  ExternalPaymentRequest,
  ManualPaymentInstructions,
  EventBus,
  EventPayload,
  WaterfallListener,
  ExtensionPoint,
  ExtensionPointId,
  HttpMethod,
  HttpReply,
  HttpRequest,
  NavItem,
  NavSurface,
  OrderPriceContext,
  PluginContext,
  PluginDefinition,
  PluginDependency,
  PluginExtensionConsumer,
  PluginEventListener,
  PluginLogger,
  PluginManifest,
  PluginPermission,
  PluginCapability,
  PluginSecrets,
  PluginRoleName,
  PluginRoleTemplate,
  PluginRoute,
  PluginRouteBase,
  HandledPluginRoute,
  RawPluginRoute,
  RawHttpRequest,
  RawHttpReply,
  RawRouteHandler,
  CorsPolicy,
  PaymentMethod,
  PaymentProvider,
  PaymentSettlement,
  PaymentSettlementHandler,
  ResolvedPaymentSettlement,
  RouteAuth,
  RouteHandler,
} from './plugin.js';
export type {
  AdminPaymentCancelResult,
  AdminPaymentConfirmResult,
  ChannelMethod,
  ExternalPaymentCancelResult,
  ExternalPaymentCreateInput,
  ExternalPaymentCreated,
  ExternalPaymentRecord,
  ExternalTopUpCancelResult,
  PaymentMethodListing,
  PaymentOrderLink,
  PaymentPurpose,
  PaymentSettleResult,
  PaymentService,
  SalesChannelView,
  WalletTopUpView,
} from './payments.js';
export { PaymentError, isPaymentError } from './payments.js';
export { FxError, isFxError } from './fx.js';
export type {
  AuthService,
  AuthUser,
  AuthAuditInput,
  CreatedPlatformToken,
  CreatePlatformTokenInput,
  PermissionGroup,
  PlatformTokenView,
  PlatformTokenInspection,
  RegisterUserInput,
  ResolvedPlatformToken,
  SessionCookieConfig,
  SessionResult,
} from './auth.js';
export type { FxQuote, FxRate, FxService } from './fx.js';
export type { StateService } from './state.js';
export type { MediaReferenceService } from './media.js';
export type { JobContext, JobHandler, JobOptions, JobSchedule } from './jobs.js';
export type { ChannelTerminal, PaymentMethodInstance, SalesChannel } from './sales.js';
export { CommerceError, isCommerceError } from './commerce.js';
export type {
  CommerceBindServiceInput,
  CommerceCatalogQuery,
  CommerceFailure,
  CommerceList,
  CommerceOperations,
  CommerceOrder,
  CommerceOrderInput,
  CommerceProduct,
  CommerceService,
  CommerceServiceAction,
  CommerceServiceInput,
  CommerceServicePatch,
} from './commerce.js';
export type {
  WalletAccount,
  WalletAdjustmentInput,
  WalletLedgerEntry,
  WalletLedgerRef,
  WalletService,
} from './wallet.js';
export { WalletError, isWalletError } from './wallet.js';
export { EXTENSION_POINTS } from './plugin.js';
export { REDIS_KEY_PREFIX, redisKey } from './key-prefixes.js';
export type { RedisKeyNamespace } from './key-prefixes.js';
export {
  SEO_MAX_PAGE_SIZE,
  SEO_RESERVED_DISALLOW,
  SEO_SITEMAP_URL_LIMIT,
  dedupeSeoUrlEntries,
  defineSeoProvider,
  isSeoProvider,
  mergeSeoMeta,
  normalizeSeoPath,
  seoAlternatesToLanguages,
  toAbsoluteUrl,
} from './seo.js';
export type {
  SeoAlternate,
  SeoChangeFrequency,
  SeoEntityMeta,
  SeoFeedEntry,
  SeoFeedPage,
  SeoMetaResult,
  SeoProvider,
  SeoRobots,
  SeoRobotsRule,
  SeoSitemapEntry,
  SeoSitemapPage,
  SeoUrlEntry,
} from './seo.js';
export { DEFAULT_PLATFORM_INFO } from './types.js';
export * from './schemas.js';
export type * from './types.js';
export { customModelPermissions, defineModel } from './models.js';
export type {
  CustomModelDefinition,
  CustomResource,
  CustomResourceInstance,
  CustomResourceList,
  ModelFieldType,
  ModelIndex,
} from './models.js';
export {
  EXTENSION_MAX_PAGE_SIZE,
  MAX_LIST_ALL,
  ExtensionError,
  ExtensionNotFound,
  ExtensionUnknownField,
  ExtensionUnknownKind,
  ExtensionUnsupportedMigration,
  ExtensionUniqueViolation,
  ExtensionValidationError,
  ExtensionVersionConflict,
  isExtensionNotFound,
  isExtensionVersionConflict,
} from './extensions.js';
export type {
  ExtensionClient,
  ExtensionCondition,
  ExtensionCreateOptions,
  ExtensionFinalizer,
  ExtensionInstance,
  ExtensionListResult,
  ExtensionPatch,
  ExtensionQuery,
  ExtensionTransaction,
  ExtensionUpdateOptions,
  ExtensionWhere,
} from './extensions.js';
export {
  MCP_PROTOCOL_VERSION,
  MCP_WRITE_SCOPE,
  McpServer,
  McpToolInputError,
  buildMcpApiCall,
  buildMcpTool,
  buildMcpTools,
  isMcpWriteAuthorized,
  mcpToolName,
} from './mcp.js';
export type {
  McpApiCall,
  McpCapability,
  McpInputSchema,
  McpJsonRpcError,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpServerInfo,
  McpServerOptions,
  McpToolAnnotations,
  McpToolArguments,
  McpToolDescriptor,
  McpToolResult,
  McpToolResultContent,
} from './mcp.js';
