import type { ComponentType, ReactNode } from 'react';
import { z } from 'zod';
import type { ApiClient } from './client.js';
import type { SeoEntityMeta } from './seo.js';
import type { PlatformInfo } from './types.js';

/** Source selected by the generic user-facing route resolver. */
export type FrontendPageSource = 'theme' | 'plugin' | 'builtin';

/** Props received by a rendered frontend page component. */
export interface FrontendPageProps<P extends Record<string, unknown> = Record<string, unknown>> {
  params: Record<string, string>;
  settings: FrontendSettings;
  data: P;
  actions: FrontendActionExecutors;
  /** API origin for resolving theme/plugin asset URLs at runtime. */
  assetsBaseUrl?: string;
}

/** A page component may be stored with the page union and narrowed at render. */
export type FrontendPageComponent = ComponentType<FrontendPageProps>;

/** A navigation item supplied by the platform from active plugin declarations. */
export interface FrontendNavigationItem {
  label: string;
  href: string;
}

/** A category node as exposed by the catalog plugin finder (`catalog.categories`). */
export interface FrontendCategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  sortOrder: number;
  productCount: number;
  children: FrontendCategoryNode[];
}

/** Props supplied to a theme layout by the platform rendering host. */
export interface FrontendLayoutProps {
  children: ReactNode;
  navigation: FrontendNavigationItem[];
  isAuthenticated: boolean;
  platform: PlatformInfo;
  /** Product category tree from the catalog plugin, when available. */
  categories?: FrontendCategoryNode[];
  /** Platform brand asset URLs resolved from the active theme, when available. */
  brand?: {
    logoUrl: string | null;
    faviconUrl: string | null;
  };
  /** API origin for resolving theme/plugin asset URLs at runtime. */
  assetsBaseUrl?: string;
}

/** One server-side action executor bound to a declared plugin action. */
export type FrontendActionExecutor = (formData: FormData) => Promise<void>;

/** Actions made available to a rendered plugin page. */
export type FrontendActionExecutors = Record<string, FrontendActionExecutor>;

/** A named layout component that wraps one rendered frontend page. */
export type FrontendLayoutComponent = ComponentType<FrontendLayoutProps>;

/** Serializable declaration for one page-level template. */
export interface FrontendPageDefinition {
  path: string;
  component: string;
  data?: FrontendPageDataRequirement[];
  layout?: string;
  /**
   * Page-level metadata declared statically by the theme/plugin (ADR-0011 §4).
   * Entity-level `seo.provider.resolveMeta` output overrides these fields.
   */
  meta?: SeoEntityMeta;
}

/** Serializable declaration included in frontend/manifest.json. */
export type FrontendPageManifestEntry = FrontendPageDefinition;

/** A finder call that supplies page data before rendering. */
export interface FrontendPageDataRequirement {
  finder: string;
  as: string;
  input?: Record<string, unknown>;
  /** Optional permission required before this Finder runs. */
  permission?: string;
}

/** Minimal session info available to Finder handlers. */
export interface FinderSession {
  role: 'ADMIN' | 'USER';
}

/** Context passed to Finder handlers while a frontend page renders. */
export interface FinderContext {
  params: Record<string, string>;
  settings: FrontendSettings;
  api: ApiClient;
  session?: FinderSession | null;
}

/** Halo Finder equivalent: a named server-side data provider. */
export interface FinderProvider<Result = unknown> {
  handler(input: Record<string, unknown>, ctx: FinderContext): Promise<Result>;
}

/** Priority used by the page resolver: theme, then plugin, then built-in. */
export function resolveFrontendPageSource(
  themePages: readonly FrontendPageDefinition[],
  pluginPages: readonly FrontendPageDefinition[],
  path: string,
): FrontendPageSource {
  if (hasExplicitPageMatch(themePages, path)) return 'theme';
  if (hasExplicitPageMatch(pluginPages, path)) return 'plugin';
  if (themePages.some((page) => isFallbackPagePattern(page.path))) return 'theme';
  if (pluginPages.some((page) => isFallbackPagePattern(page.path))) return 'plugin';
  return 'builtin';
}

/** Select the most concrete page definition that matches a request path. */
export function selectFrontendPageDefinition(
  pages: readonly FrontendPageDefinition[],
  path: string,
): FrontendPageDefinition | undefined {
  let best: { page: FrontendPageDefinition; score: number; index: number } | null = null;
  for (const [index, page] of pages.entries()) {
    if (!matchFrontendPagePath(page.path, path)) continue;
    const score = frontendPathSpecificity(page.path);
    if (!best || score > best.score || (score === best.score && index < best.index)) {
      best = { page, score, index };
    }
  }
  return best?.page;
}

function hasExplicitPageMatch(pages: readonly FrontendPageDefinition[], path: string): boolean {
  return pages.some(
    (page) => !isFallbackPagePattern(page.path) && matchFrontendPagePath(page.path, path),
  );
}

function isFallbackPagePattern(pattern: string): boolean {
  return pattern === '*' || pattern === '/**';
}

function frontendPathSpecificity(pattern: string): number {
  if (isFallbackPagePattern(pattern)) return -1;
  return pattern
    .split('/')
    .filter(Boolean)
    .reduce(
      (score, segment) =>
        score + (segment === '*' || segment === '**' ? 0 : segment[0] === ':' ? 1 : 2),
      0,
    );
}

/** Match a page path pattern (`/content/:id`) against a request path. */
export function matchFrontendPagePath(pattern: string, path: string): boolean {
  if (pattern === '*') return true;
  const patternSegments = pattern.split('/').filter((segment) => segment.length > 0);
  const pathSegments = path.split('/').filter((segment) => segment.length > 0);
  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index];
    if (segment === undefined) return false;
    const requestSegment = pathSegments[index];
    if (index === patternSegments.length - 1 && (segment === '*' || segment === '**')) return true;
    if (segment.startsWith(':')) {
      if (requestSegment === undefined) return false;
      continue;
    }
    if (segment === '*') {
      if (requestSegment === undefined) return false;
      continue;
    }
    if (segment !== requestSegment) return false;
  }
  return patternSegments.length === pathSegments.length;
}

/** Extract `:param` and wildcard segments from a matched request path. */
export function captureFrontendPathParams(pattern: string, path: string): Record<string, string> {
  const patternSegments = pattern.split('/').filter((segment) => segment.length > 0);
  const pathSegments = path.split('/').filter((segment) => segment.length > 0);
  const params: Record<string, string> = {};
  patternSegments.forEach((segment, index) => {
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = pathSegments[index] ?? '';
    } else if (segment === '*' || segment === '**') {
      params['*'] = pathSegments.slice(index).join('/');
    }
  });
  return params;
}

/**
 * Resolve the theme component id that overrides a plugin page path, if any.
 *
 * Override keys are matched exactly first, then by the most concrete path
 * pattern (same semantics as `selectFrontendPageDefinition`). A theme can
 * declare `{ '/shop': 'shop', '/shop/:id': 'shopDetail' }` to take over the
 * store plugin's catalog and detail pages.
 */
export function resolveThemeOverride(
  overrides: Record<string, string> | undefined,
  path: string,
): string | undefined {
  if (!overrides) return undefined;
  if (overrides[path]) return overrides[path];
  const entries = Object.entries(overrides);
  if (entries.length === 0) return undefined;
  let best: { pattern: string; component: string; score: number } | null = null;
  for (const [pattern, component] of entries) {
    if (!matchFrontendPagePath(pattern, path)) continue;
    const score = frontendPathSpecificity(pattern);
    if (!best || score > best.score) {
      best = { pattern, component, score };
    }
  }
  return best?.component;
}

/** Non-secret settings stored per theme/plugin and passed into templates. */
export type FrontendSettings = Record<string, Record<string, string | number | boolean>>;

/** A single field declaration accepted by the admin settings form. */
export type FrontendSettingsField =
  | {
      type: 'text' | 'textarea' | 'color';
      name: string;
      label: string;
      default?: string;
      placeholder?: string;
      help?: string;
      required?: boolean;
    }
  | {
      type: 'number';
      name: string;
      label: string;
      default?: number;
      min?: number;
      max?: number;
      step?: number;
      help?: string;
      required?: boolean;
    }
  | {
      type: 'boolean';
      name: string;
      label: string;
      default?: boolean;
      help?: string;
      required?: boolean;
    }
  | {
      type: 'select' | 'radio';
      name: string;
      label: string;
      default?: string;
      options: Array<{ label: string; value: string }>;
      help?: string;
      required?: boolean;
    };

/** A labelled group rendered as a settings section in the admin form. */
export interface FrontendSettingsGroup {
  id: string;
  label: string;
  fields: FrontendSettingsField[];
}

/** Settings schema equivalent of Halo's settings.yaml. */
export interface FrontendSettingsSchema {
  groups: FrontendSettingsGroup[];
}

/** Compiled frontend package metadata stored as frontend/manifest.json. */
export interface FrontendManifest {
  version: string;
  /** Content-derived cache buster; changes on every frontend rebuild. */
  revision: string;
  /** Entry file relative to the frontend package root. */
  entry: string;
  pages: FrontendPageManifestEntry[];
  layouts: string[];
  finders: string[];
  adminRoutes: AdminRouteDefinition[];
  adminActions: AdminActionDefinition[];
  actions: PluginActionDefinition[];
  accountRoutes: AccountRouteDefinition[];
  accountWidgets: AccountWidgetDefinition[];
  files: string[];
  settingsSchema?: FrontendSettingsSchema;
  /** Interface locales this package ships messages for (ADR-0016 §5). */
  locales?: string[];
  /** Theme-only: plugin page path -> theme component id overrides. */
  overrides?: Record<string, string>;
}

/** Runtime shape exported by a compiled frontend package. */
export interface FrontendPackage {
  /** Page-level templates keyed by the `component` id in `pages`. */
  pageComponents?: Record<string, FrontendPageComponent>;
  pages?: FrontendPageDefinition[];
  layouts?: Record<string, FrontendLayoutComponent>;
  finders?: Record<string, FinderProvider>;
  settingsSchema?: FrontendSettingsSchema;
  ui?: FrontendUi;
  /** Interface locales this package ships messages for (ADR-0016 §5). */
  locales?: string[];
  /**
   * Theme-only: override plugin-provided pages so the theme owns the visual
   * shell while the plugin keeps supplying data and actions.
   *
   * Key: the plugin page path pattern (e.g. `/shop`, `/shop/:id`).
   * Value: the component id in this package's `pageComponents`.
   *
   * When the active theme declares an override for a requested path, the
   * platform renders the theme's component but still resolves the page data
   * requirements, finders and actions from the matching plugin package.
   */
  overrides?: Record<string, string>;
}

/** Type-check a compiled frontend package literal. */
export function defineFrontend(pkg: FrontendPackage): FrontendPackage {
  return pkg;
}

/** Props passed to an admin dashboard widget rendered by the platform. */
export interface AdminWidgetProps {
  pluginId: string;
}

/** Serializable extension metadata registered by the plugin backend. */
export interface AdminDashboardWidgetMeta {
  id: string;
  title: string;
  description?: string;
}

/** Declarative UI extensions shipped inside a compiled frontend package. */
export interface FrontendUi {
  adminWidgets?: Record<string, ComponentType<AdminWidgetProps>>;
  adminPages?: Record<string, AdminPageComponent>;
  adminRoutes?: AdminRouteDefinition[];
  adminActions?: AdminActionDefinition[];
  adminActionComponents?: Record<string, AdminActionComponent>;
  accountPages?: Record<string, AccountPageComponent>;
  accountRoutes?: AccountRouteDefinition[];
  accountWidgetComponents?: Record<string, AccountWidgetComponent>;
  accountWidgets?: AccountWidgetDefinition[];
  actions?: PluginActionDefinition[];
}

/** A route contributed by a plugin to the signed-in user's account center. */
export interface AccountRouteDefinition {
  path: string;
  component: string;
  permission?: string;
  data?: FrontendPageDataRequirement[];
  nav?: AccountMenuDefinition;
}

/** Scalar field accepted by a declared plugin action. */
export interface PluginActionInputField {
  name: string;
  type: 'string' | 'integer' | 'number' | 'money' | 'boolean' | 'ids';
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  default?: string | number | boolean;
}

/** Optional redirect derived from a plugin action response. */
export interface PluginActionRedirect {
  responsePath: string;
  external?: boolean;
}

/**
 * A form-compatible mutation declared by a frontend package. The platform
 * validates the declaration and owns session, permission, input, audit, and
 * BFF concerns before dispatching to the plugin backend.
 */
export interface PluginActionDefinition {
  id: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  permission?: string;
  input?: PluginActionInputField[];
  redirect?: PluginActionRedirect;
}

/** A compact account overview module contributed by an active plugin. */
export interface AccountWidgetDefinition {
  id: string;
  title: string;
  component: string;
  permission?: string;
}

/** A navigation item shown in the account-center sidebar. */
export interface AccountMenuDefinition {
  label: string;
  /**
   * Top-level account menu this item belongs to. The account shell groups items
   * into 服务 (business objects) and 费用 (money); anything else falls back to
   * 服务. Use '费用' for billing-related pages (余额充值, 历史订单, ...).
   */
  group?: string;
}

/** Minimal authenticated identity exposed to trusted account frontend packages. */
export interface AccountUser {
  id: string;
  email: string;
  role: 'ADMIN' | 'USER';
}

/** Props passed to a plugin page rendered inside the account center. */
export interface AccountPageComponentProps {
  pluginId: string;
  path: string;
  params: Record<string, string>;
  /**
   * URL query parameters of the current request (e.g. `?q=claude&model=…`).
   * Enables server-rendered client-side-ish interactions — filtering, row
   * selection — without shipping a client bundle. Values are the raw strings,
   * with repeated keys collapsed to the first value.
   */
  searchParams: Record<string, string>;
  settings: FrontendSettings;
  data: Record<string, unknown>;
  user: AccountUser;
  actions: FrontendActionExecutors;
}

export type AccountPageComponent = ComponentType<AccountPageComponentProps>;

/** Props passed to a compact plugin account overview component. */
export interface AccountWidgetProps {
  pluginId: string;
  user: AccountUser;
  settings: FrontendSettings;
}

export type AccountWidgetComponent = ComponentType<AccountWidgetProps>;

/** Serialized admin route shipped inside a compiled frontend package. */
export interface AdminRouteDefinition {
  path: string;
  component: string;
  permission?: string;
  data?: FrontendPageDataRequirement[];
  nav?: AdminMenuDefinition;
}

/** Serialized admin action shipped inside a compiled frontend package. */
export interface AdminActionDefinition {
  id: string;
  label: string;
  permission?: string;
  component: string;
}

/** Props passed to a plugin admin action component. */
export interface AdminActionComponentProps {
  pluginId: string;
}

export type AdminActionComponent = ComponentType<AdminActionComponentProps>;

/** Admin sidebar menu contributed by a plugin frontend package. */
export interface AdminMenuDefinition {
  label: string;
  group?: string;
}

/** Props passed to a plugin admin page component. */
export interface AdminPageComponentProps {
  pluginId: string;
  path: string;
  params: Record<string, string>;
  settings: FrontendSettings;
  data: Record<string, unknown>;
  actions: FrontendActionExecutors;
}

export type AdminPageComponent = ComponentType<AdminPageComponentProps>;

/** API response for GET /themes/:id/frontend and GET /plugins/:id/frontend. */
export interface FrontendDescriptor {
  available: boolean;
  manifest: FrontendManifest | null;
}

/** API response for settings schema endpoints. */
export interface SettingsSchemaResponse {
  schema: FrontendSettingsSchema | null;
}

/** API response for settings GET endpoints. */
export interface SettingsResponse {
  settings: FrontendSettings;
}

/** Summary included on admin theme/plugin rows. */
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
/**
 * Build a zod validator for a frontend settings schema. Missing groups/fields
 * are replaced with their declared defaults, matching Halo's theme.config
 * behavior while keeping the API and admin form on one contract.
 */
export function buildZodFromSettingsSchema(
  schema: FrontendSettingsSchema,
): z.ZodType<FrontendSettings> {
  const groupShape: Record<string, z.ZodTypeAny> = {};
  for (const group of schema.groups) {
    const fieldShape: Record<string, z.ZodTypeAny> = {};
    const groupDefaults: Record<string, string | number | boolean> = {};
    for (const field of group.fields) {
      fieldShape[field.name] = buildFieldSchema(field);
      if ('default' in field && field.default !== undefined) {
        groupDefaults[field.name] = field.default;
      }
    }
    groupShape[group.id] = z.object(fieldShape).default(groupDefaults);
  }
  return z.object(groupShape) as unknown as z.ZodType<FrontendSettings>;
}

/** Defaults for every declared field, used when no persisted value exists. */
export function settingsDefaultsFromSchema(schema: FrontendSettingsSchema): FrontendSettings {
  const result: FrontendSettings = {};
  for (const group of schema.groups) {
    const values: Record<string, string | number | boolean> = {};
    for (const field of group.fields) {
      if ('default' in field && field.default !== undefined) {
        values[field.name] = field.default;
      }
    }
    result[group.id] = values;
  }
  return result;
}

/** Merge persisted/partial settings over defaults without mutating inputs. */
export function mergeFrontendSettings(
  base: FrontendSettings,
  patch: FrontendSettings | undefined,
): FrontendSettings {
  const result: FrontendSettings = {};
  for (const [group, values] of Object.entries(base)) {
    result[group] = { ...values };
  }
  if (!patch) return result;
  for (const [group, values] of Object.entries(patch)) {
    result[group] = { ...(result[group] ?? {}), ...values };
  }
  return result;
}

function buildFieldSchema(field: FrontendSettingsField): z.ZodTypeAny {
  switch (field.type) {
    case 'number':
      return z
        .number()
        .int()
        .min(field.min ?? Number.MIN_SAFE_INTEGER)
        .max(field.max ?? Number.MAX_SAFE_INTEGER)
        .default(field.default ?? 0);
    case 'boolean':
      return z.boolean().default(field.default ?? false);
    case 'select':
    case 'radio': {
      const values = field.options.map((option) => option.value);
      return z.enum(values as [string, ...string[]]).default(field.default ?? values[0] ?? '');
    }
    default:
      return z.string().default(field.default ?? '');
  }
}
