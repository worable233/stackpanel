/**
 * Extension engine data-access contract (`ctx.extensions` / `ctx.tx`).
 *
 * The kernel derives one real table per declared model, generates a typed
 * indexed column per `ModelIndex` field, and hands every plugin a client that
 * only knows that plugin's own kinds. Queries are parameterised; the only
 * fields addressable in a `where`/`orderBy` are the declared index fields plus
 * the built-ins (`name`/`ownerId`/`createdAt`/`updatedAt`). Anything else is a
 * programming error and fails loudly instead of degrading to a scan.
 *
 * Access shape mirrors the old Prisma calls so migrations are mechanical:
 * `findMany` → `list`/`listAll`, `findFirst` → `get`, `create/update/delete`
 * one-to-one. The one deliberate difference is that `list` is **paged** — there
 * is no unbounded read; use `listAll` (bounded by {@link MAX_LIST_ALL}) when a
 * caller genuinely needs everything.
 */

import { PluginError, brandSdkErrorClass, isSdkErrorClass } from './errors.js';
import type { CustomModelDefinition } from './models.js';
import type { PaymentService } from './payments.js';
import type { WalletService } from './wallet.js';

/** Max `pageSize` accepted by {@link ExtensionClient.list}. */
export const EXTENSION_MAX_PAGE_SIZE = 200;

/** Max rows `listAll` will accumulate before refusing (runaway-query guard). */
export const MAX_LIST_ALL = 5000;

/** One field predicate. At most one operator per field. */
export interface ExtensionCondition {
  eq?: unknown;
  in?: unknown[];
  gte?: number;
  gt?: number;
  lte?: number;
  lt?: number;
  /** Substring match; only valid on `string` fields. */
  contains?: string;
}

/** Query predicate keyed by field name (index fields or built-ins). */
export type ExtensionWhere = Record<string, ExtensionCondition>;

/** One stored instance of a plugin-declared model. */
export interface ExtensionInstance<T = unknown> {
  /** Instance id (`metadata.name`). */
  name: string;
  /** Validated payload (was `data` / `spec`). */
  spec: T;
  /** Free-form observed state written by the plugin. */
  status: unknown;
  ownerId: string | null;
  /** Optimistic-concurrency version, starts at 1. */
  version: number;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  finalizers: string[];
  createdAt: Date;
  updatedAt: Date;
  /** Non-null once a finalizer-bearing instance is pending physical deletion. */
  deletionTimestamp: Date | null;
}

/** Paged query. `page`/`pageSize` are required — there is no unbounded read. */
export interface ExtensionQuery {
  where?: ExtensionWhere;
  orderBy?: { field: string; desc?: boolean };
  /** 1-based page number. */
  page: number;
  /** 1–{@link EXTENSION_MAX_PAGE_SIZE}. */
  pageSize: number;
}

export interface ExtensionListResult<T> {
  items: ExtensionInstance<T>[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ExtensionCreateOptions {
  /** Explicit id; defaults to a generated cuid. */
  name?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerId?: string | null;
}

export interface ExtensionUpdateOptions {
  /** Reject the write when the stored version differs. */
  expectedVersion?: number;
}

/** Atomic patch operator: set a scalar or apply an arithmetic step. */
export type ExtensionPatch = Record<string, { set: unknown } | { inc: number } | { dec: number }>;

/** A named handler run (in order) before an instance is physically deleted. */
export type ExtensionFinalizer = (instance: ExtensionInstance<unknown>) => Promise<void>;

export interface ExtensionClient {
  /** Read one instance by id, or `null`. */
  get<T>(model: CustomModelDefinition, name: string): Promise<ExtensionInstance<T> | null>;
  /** Paged query; `page`/`pageSize` are required. */
  list<T>(model: CustomModelDefinition, query: ExtensionQuery): Promise<ExtensionListResult<T>>;
  /** Read every matching row, page by page; refuses beyond {@link MAX_LIST_ALL}. */
  listAll<T>(
    model: CustomModelDefinition,
    query?: Omit<ExtensionQuery, 'page' | 'pageSize'>,
  ): Promise<ExtensionInstance<T>[]>;
  /** Create one instance (payload validated by the model schema). */
  create<T>(
    model: CustomModelDefinition,
    spec: T,
    opts?: ExtensionCreateOptions,
  ): Promise<ExtensionInstance<T>>;
  /** Replace the payload; bumps `version` (conflict → ExtensionVersionConflict). */
  update<T>(
    model: CustomModelDefinition,
    name: string,
    spec: T,
    opts?: ExtensionUpdateOptions,
  ): Promise<ExtensionInstance<T>>;
  /** Atomic conditional update on declared fields; returns the rows changed. */
  updateWhere(
    model: CustomModelDefinition,
    where: ExtensionWhere,
    patch: ExtensionPatch,
  ): Promise<{ updated: number }>;
  /** Run finalizers (if any) then delete, or delete directly. */
  delete(model: CustomModelDefinition, name: string): Promise<void>;
  /** Register a finalizer referenced by name in the model's `finalizers`. */
  registerFinalizer(model: CustomModelDefinition, name: string, handler: ExtensionFinalizer): void;
}

/**
 * The services available inside `ctx.tx`. Only extensions and the kernel
 * services that can genuinely join a transaction are exposed — a wallet write
 * and its data write must commit or roll back together.
 */
export interface ExtensionTransaction {
  readonly extensions: ExtensionClient;
  readonly wallet: Pick<WalletService, 'debit' | 'credit'>;
  readonly payments: Pick<PaymentService, 'createRecord'>;
}

/** Base class for engine errors; carries a stable code and HTTP status. */
export class ExtensionError extends PluginError {
  constructor(code: string, status: number, detail?: string) {
    super(code, status, detail);
    this.name = 'ExtensionError';
  }
}

/** Access to a kind this plugin did not declare. */
export class ExtensionUnknownKind extends ExtensionError {
  constructor(kind: string) {
    super('extension.unknown_kind', 403, `未声明的模型：${kind}`);
    this.name = 'ExtensionUnknownKind';
  }
}

/** `where`/`orderBy` referenced a field that is neither declared nor built-in. */
export class ExtensionUnknownField extends ExtensionError {
  constructor(field: string) {
    super('extension.unknown_field', 422, `不可查询的字段：${field}`);
    this.name = 'ExtensionUnknownField';
  }
}

/** `get`/`update`/`delete` target does not exist. */
export class ExtensionNotFound extends ExtensionError {
  constructor(name: string) {
    super('extension.not_found', 404, `实例不存在：${name}`);
    this.name = 'ExtensionNotFound';
  }
}

/** Payload failed the model's zod schema or an index-type check. */
export class ExtensionValidationError extends ExtensionError {
  constructor(detail: string) {
    super('extension.validation_error', 422, detail);
    this.name = 'ExtensionValidationError';
  }
}

/** A unique index was violated. */
export class ExtensionUniqueViolation extends ExtensionError {
  constructor(detail: string) {
    super('extension.unique_violation', 409, detail);
    this.name = 'ExtensionUniqueViolation';
  }
}

/** Optimistic-concurrency version mismatch. */
export class ExtensionVersionConflict extends ExtensionError {
  constructor(name: string) {
    super('extension.version_conflict', 409, `实例已被修改：${name}`);
    this.name = 'ExtensionVersionConflict';
  }
}

/** A schema change the E1 migrator refuses (type/column/uniqueness rewrite). */
export class ExtensionUnsupportedMigration extends ExtensionError {
  constructor(detail: string) {
    super('extension.unsupported_migration', 500, detail);
    this.name = 'ExtensionUnsupportedMigration';
  }
}

// Cross-module guards for the subclasses consumers narrow on. `isPluginError`
// proves a value is *some* deterministic error; these prove *which* one even
// when the plugin loader produced a duplicate class object (see errors.ts).
brandSdkErrorClass(ExtensionNotFound, 'ExtensionNotFound');
brandSdkErrorClass(ExtensionVersionConflict, 'ExtensionVersionConflict');

/** True when `value` is an {@link ExtensionNotFound}, across duplicated SDK modules. */
export function isExtensionNotFound(value: unknown): value is ExtensionNotFound {
  return isSdkErrorClass(value, 'ExtensionNotFound');
}

/** True when `value` is an {@link ExtensionVersionConflict}, across duplicated SDK modules. */
export function isExtensionVersionConflict(value: unknown): value is ExtensionVersionConflict {
  return isSdkErrorClass(value, 'ExtensionVersionConflict');
}
