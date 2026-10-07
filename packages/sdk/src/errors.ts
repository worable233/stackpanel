/** Error thrown by {@link ApiClient} for any failed or malformed response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** Correlation id from the problem-details body, when present (ADR-0015). */
  readonly requestId: string | undefined;
  /** Field-level failures from the problem-details body, when present. */
  readonly errors: FieldError[] | undefined;

  constructor(
    message: string,
    options: {
      status: number;
      code?: string;
      details?: unknown;
      requestId?: string;
      errors?: FieldError[];
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code ?? 'unknown';
    this.details = options.details;
    this.requestId = options.requestId;
    this.errors = options.errors;
  }
}

/** A single field-level validation failure (RFC 7807 `errors[]` entry). */
export interface FieldError {
  /** Dotted path of the offending field, e.g. `email` or `items.0.sku`. */
  field: string;
  /** Stable, machine-readable code, e.g. `validation.invalid_format`. */
  code: string;
  /** Neutral English message. The UI localises by `code` where possible. */
  message: string;
}

/**
 * RFC 7807 / RFC 9457 Problem Details body (`application/problem+json`).
 *
 * Every error response the API emits uses this shape. `code` is the real
 * contract; `type`/`title`/`detail` are neutral English fallbacks (ADR-0012
 * §4: the API does not localise — the UI renders by `code`).
 */
export interface ProblemDetails {
  /** Stable URI identifying the error class. */
  type: string;
  /** Short, neutral English title. */
  title: string;
  /** HTTP status, mirroring the response. */
  status: number;
  /** Neutral English explanation; never leaks internals on 5xx. */
  detail?: string;
  /** Request path that produced the error. */
  instance?: string;
  /** Stable, namespaced, machine-readable code — the real contract. */
  code: string;
  /** Correlation id, also present in the API logs (ADR-0015). */
  requestId?: string;
  /** Field-level failures (present for validation errors). */
  errors?: FieldError[];
}

/**
 * Error a plugin (or kernel route) can throw to produce a deterministic
 * problem-details response. The kernel error boundary catches it and renders
 * {@link ProblemDetails}; uncaught errors become a generic 500.
 *
 * @example
 * throw new PluginError('store.insufficient_stock', 409, 'Not enough stock left');
 */
export class PluginError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: FieldError[] | undefined;

  constructor(code: string, status = 400, detail?: string, errors?: FieldError[]) {
    super(code);
    this.name = 'PluginError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.errors = errors;
  }
}

/**
 * Non-enumerable brand marking every plugin-thrown error.
 *
 * `instanceof PluginError` is **not** reliable across module instances: the
 * kernel loads plugin bundles through a cache-busted URL (`?v=<timestamp>`), so
 * a plugin's `import { PluginError } from '@stackpanel/sdk'` can resolve to a
 * distinct class object from the kernel's own import. That silently defeated
 * `error instanceof PluginError`, turning a deterministic 401 into a 500.
 *
 * The brand is a string-valued, inherited-by-prototype property, so it survives
 * module duplication and cross-realm boundaries (worker/VM). {@link isPluginError}
 * checks the brand, never `instanceof`; kernel error handling must use it.
 */
const PLUGIN_ERROR_BRAND = '__stackpanelPluginError';

Object.defineProperty(PluginError.prototype, PLUGIN_ERROR_BRAND, {
  value: true,
  enumerable: false,
  writable: false,
  configurable: false,
});

/** Shape a branded plugin error carries, independent of the class identity. */
export interface BrandedPluginError {
  code: string;
  status: number;
  detail?: string;
  errors?: FieldError[];
}

/**
 * True when `value` is a plugin error, matched by {@link PLUGIN_ERROR_BRAND}
 * rather than `instanceof`, so it is correct even when the SDK class was loaded
 * more than once. Use this in kernel error boundaries instead of `instanceof`.
 */
export function isPluginError(value: unknown): value is PluginError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[PLUGIN_ERROR_BRAND] === true
  );
}

/**
 * Base class for deterministic errors thrown by the kernel-owned domain
 * services (payments, wallet, FX, commerce). Extending {@link PluginError} ties
 * them into the same brand contract: the kernel error boundary renders their
 * `status`/`code`/`detail` instead of collapsing to a generic 500, even when
 * the class object was duplicated by the plugin loader's cache-busted import.
 *
 * `message` and `detail` both carry the human-readable reason (the provider's
 * original text where one exists); `code` and `status` are the machine contract.
 */
export class KernelError extends PluginError {
  /** Alias so Fastify's error handler maps the error to an HTTP status. */
  readonly statusCode: number;

  constructor(code: string, status: number, displayMessage: string) {
    super(code, status, displayMessage);
    this.name = 'KernelError';
    // `PluginError` sets `message = code`; keep the display text instead.
    this.message = displayMessage;
    this.statusCode = status;
  }
}

/**
 * Non-enumerable brand recording the SDK error class that minted a value.
 *
 * `instanceof` is unreliable across module instances (the kernel loads plugin
 * bundles through a cache-busted URL, so a plugin's `@stackpanel/sdk` can be a
 * distinct copy). This brand stores a stable class *name* on the prototype, so
 * {@link isSdkErrorClass} narrows correctly regardless of class identity. It is
 * separate from {@link PLUGIN_ERROR_BRAND}, which marks the whole deterministic
 * error family.
 */
const SDK_ERROR_BRAND = '__stackpanelSdkError';

/** Tag `cls` with a stable, cross-module identity. Call once, at class definition. */
export function brandSdkErrorClass(cls: { prototype: object }, name: string): void {
  Object.defineProperty(cls.prototype, SDK_ERROR_BRAND, {
    value: name,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/** True when `value` was minted by the class tagged `name`, module-identity agnostic. */
export function isSdkErrorClass(value: unknown, name: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[SDK_ERROR_BRAND] === name
  );
}
