/**
 * Extension 引擎：能力化客户端 `ctx.extensions`（ADR-0009 §3–§5）。
 *
 * 客户端按插件身份绑定：只能看到自己声明的 kind（{@link ExtensionRegistry}），
 * 查询只允许已声明字段与内建字段。所有写入都是参数化 SQL；DDL 从不在这里出现。
 */

import { randomUUID } from 'node:crypto';
import type {
  CustomModelDefinition,
  ExtensionClient,
  ExtensionFinalizer,
  ExtensionInstance,
  ExtensionListResult,
  ExtensionPatch,
  ExtensionQuery,
  ExtensionWhere,
} from '@stackpanel/sdk';
import {
  EXTENSION_MAX_PAGE_SIZE,
  MAX_LIST_ALL,
  ExtensionNotFound,
  ExtensionUniqueViolation,
  ExtensionValidationError,
  ExtensionVersionConflict,
} from '@stackpanel/sdk';
import { compileOrderBy, compileWhere, joinClauses } from './query.ts';
import type { ExtensionColumn, ExtensionTable } from './schema.ts';
import { quoteIdentifier } from './schema.ts';
import type { ExtensionRegistry, RegisteredModel } from './registry.ts';

/** Minimal raw-SQL surface shared by PrismaClient and an interactive tx client. */
export interface RawDatabase {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

type Row = Record<string, unknown>;

const IS_DELETED = `"deleted_at" IS NULL`;
const NOT_DELETED = `"deleted_at" IS NOT NULL`;

/** Named finalizers, keyed by (pluginId, kind, name). */
export class FinalizerStore {
  private readonly handlers = new Map<string, ExtensionFinalizer>();

  private static key(pluginId: string, kind: string, name: string): string {
    return `${pluginId}\u0000${kind}\u0000${name}`;
  }

  set(pluginId: string, kind: string, name: string, handler: ExtensionFinalizer): void {
    this.handlers.set(FinalizerStore.key(pluginId, kind, name), handler);
  }

  get(pluginId: string, kind: string, name: string): ExtensionFinalizer | undefined {
    return this.handlers.get(FinalizerStore.key(pluginId, kind, name));
  }

  clearPlugin(pluginId: string): void {
    for (const key of [...this.handlers.keys()]) {
      if (key.startsWith(`${pluginId}\u0000`)) this.handlers.delete(key);
    }
  }
}

export interface ExtensionClientOptions {
  db: RawDatabase;
  registry: ExtensionRegistry;
  pluginId: string;
  /** Acting user for `scoped` models; `null` in system contexts. */
  ownerId: string | null;
  finalizers: FinalizerStore;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') return new Date(value);
  return new Date(0);
}

function asRecord(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toInstance<T>(row: Row): ExtensionInstance<T> {
  return {
    name: String(row['id']),
    spec: row['spec'] as T,
    status: row['status'] ?? null,
    ownerId: (row['owner_id'] as string | null) ?? null,
    version: Number(row['version']),
    labels: asRecord(row['labels']),
    annotations: asRecord(row['annotations']),
    finalizers: asStringArray(row['finalizers']),
    createdAt: toDate(row['created_at']),
    updatedAt: toDate(row['updated_at']),
    deletionTimestamp: row['deleted_at'] ? toDate(row['deleted_at']) : null,
  };
}

/** True when a driver error is a PostgreSQL unique-constraint violation (23505). */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: string;
    meta?: {
      code?: string;
      driverAdapterError?: { cause?: { originalCode?: string; kind?: string } };
    };
    message?: string;
  };
  if (candidate.code === '23505' || candidate.meta?.code === '23505') return true;
  // Prisma 7 wraps driver errors: raw code/kind live under `driverAdapterError.cause`.
  const cause = candidate.meta?.driverAdapterError?.cause;
  if (cause?.originalCode === '23505' || cause?.kind === 'UniqueConstraintViolation') {
    return true;
  }
  return typeof candidate.message === 'string' && candidate.message.includes('23505');
}

class ExtensionClientImpl implements ExtensionClient {
  constructor(private readonly options: ExtensionClientOptions) {}

  private resolve(model: CustomModelDefinition): RegisteredModel {
    return this.options.registry.resolve(this.options.pluginId, model);
  }

  private validate<T>(model: CustomModelDefinition, spec: T): T {
    const parsed = model.schema.safeParse(spec);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ExtensionValidationError(
        `数据校验失败：${issue ? `${issue.path.join('.')} ${issue.message}` : '未知错误'}`,
      );
    }
    return parsed.data as T;
  }

  /** Extract declared index values, enforcing scalar types. */
  private indexValues(table: ExtensionTable, spec: unknown): unknown[] {
    const payload = (spec ?? {}) as Record<string, unknown>;
    return table.columns.map((column) => coerceIndexValue(column, payload[column.field]));
  }

  private ownerValue(scoped: boolean, explicit?: string | null): string | null {
    if (explicit !== undefined) return explicit;
    return scoped ? this.options.ownerId : null;
  }

  /**
   * `scoped` models are fail-closed: without a user context the client refuses
   * to read or mutate them, so a system-context call can never leak another
   * user's rows. The generic `/custom` surface always supplies a user id.
   */
  private assertOwnerContext(table: ExtensionTable): void {
    if (table.scoped && this.options.ownerId === null) {
      throw new ExtensionValidationError('scoped 模型需要用户上下文（ownerId）');
    }
  }

  private async fetchRow(
    registered: RegisteredModel,
    name: string,
    includeDeleted = false,
  ): Promise<Row | null> {
    const params: unknown[] = [];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const clauses = [`"id" = ${push(name)}`];
    clauses.push(includeDeleted ? 'TRUE' : IS_DELETED);
    if (registered.table.scoped && this.options.ownerId) {
      clauses.push(`"owner_id" = ${push(this.options.ownerId)}`);
    }
    const sql = `SELECT * FROM ${quoteIdentifier(registered.table.tableName)} WHERE ${joinClauses(clauses)} LIMIT 1`;
    const rows = await this.options.db.$queryRawUnsafe<Row[]>(sql, ...params);
    return rows[0] ?? null;
  }

  async get<T>(
    model: CustomModelDefinition,
    name: string,
  ): Promise<ExtensionInstance<T> | null> {
    const registered = this.resolve(model);
    this.assertOwnerContext(registered.table);
    const row = await this.fetchRow(registered, name);
    return row ? toInstance<T>(row) : null;
  }

  private async listPage<T>(
    registered: RegisteredModel,
    query: ExtensionQuery,
  ): Promise<ExtensionListResult<T>> {
    this.assertOwnerContext(registered.table);
    const page = Math.max(1, Math.trunc(query.page));
    const pageSize = Math.min(EXTENSION_MAX_PAGE_SIZE, Math.max(1, Math.trunc(query.pageSize)));
    const params: unknown[] = [];
    const clauses = [IS_DELETED];
    if (registered.table.scoped && this.options.ownerId) {
      params.push(this.options.ownerId);
      clauses.push(`"owner_id" = $${params.length}`);
    }
    const predicate = compileWhere(registered.table, query.where, params);
    if (predicate) clauses.push(predicate);
    const whereSql = joinClauses(clauses);

    const limitParam = `$${params.push(pageSize)}`;
    const offsetParam = `$${params.push((page - 1) * pageSize)}`;
    const table = quoteIdentifier(registered.table.tableName);

    const rows = await this.options.db.$queryRawUnsafe<Row[]>(
      `SELECT * FROM ${table} WHERE ${whereSql} ORDER BY ${compileOrderBy(registered.table, query.orderBy)} LIMIT ${limitParam} OFFSET ${offsetParam}`,
      ...params,
    );

    // Count reuses the same predicate but with its own parameter list.
    const countParams: unknown[] = [];
    const countClauses = [IS_DELETED];
    if (registered.table.scoped && this.options.ownerId) {
      countParams.push(this.options.ownerId);
      countClauses.push(`"owner_id" = $${countParams.length}`);
    }
    const countPredicate = compileWhere(registered.table, query.where, countParams);
    if (countPredicate) countClauses.push(countPredicate);
    const counted = await this.options.db.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS "count" FROM ${table} WHERE ${joinClauses(countClauses)}`,
      ...countParams,
    );

    return {
      items: rows.map((row) => toInstance<T>(row)),
      total: Number(counted[0]?.count ?? 0),
      page,
      pageSize,
    };
  }

  async list<T>(
    model: CustomModelDefinition,
    query: ExtensionQuery,
  ): Promise<ExtensionListResult<T>> {
    return this.listPage<T>(this.resolve(model), query);
  }

  async listAll<T>(
    model: CustomModelDefinition,
    query?: Omit<ExtensionQuery, 'page' | 'pageSize'>,
  ): Promise<ExtensionInstance<T>[]> {
    const registered = this.resolve(model);
    const pageSize = EXTENSION_MAX_PAGE_SIZE;
    const items: ExtensionInstance<T>[] = [];
    let page = 1;
    for (;;) {
      const result = await this.listPage<T>(registered, { ...query, page, pageSize });
      items.push(...result.items);
      if (items.length >= result.total || result.items.length === 0) break;
      if (items.length >= MAX_LIST_ALL) {
        throw new ExtensionValidationError(`listAll 结果超过上限 ${MAX_LIST_ALL} 条`);
      }
      page += 1;
    }
    return items;
  }

  async create<T>(
    model: CustomModelDefinition,
    spec: T,
    opts?: {
      name?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
      ownerId?: string | null;
    },
  ): Promise<ExtensionInstance<T>> {
    const registered = this.resolve(model);
    const parsed = this.validate(model, spec);
    const table = registered.table;
    const ownerId = this.ownerValue(table.scoped, opts?.ownerId);
    if (table.scoped && ownerId === null) {
      throw new ExtensionValidationError('scoped 模型需要用户上下文（ownerId）');
    }
    const columns = [
      'id',
      'owner_id',
      'version',
      'spec',
      'status',
      'labels',
      'annotations',
      'finalizers',
      'created_at',
      'updated_at',
      ...table.columns.map((column) => column.column),
    ];
    const params: unknown[] = [];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const now = new Date();
    const values = [
      push(opts?.name ?? randomUUID()),
      push(ownerId),
      '1',
      `${push(JSON.stringify(parsed))}::jsonb`,
      'NULL',
      `${push(JSON.stringify(opts?.labels ?? {}))}::jsonb`,
      `${push(JSON.stringify(opts?.annotations ?? {}))}::jsonb`,
      `${push(JSON.stringify(model.finalizers ?? []))}::jsonb`,
      push(now),
      push(now),
      ...this.indexValues(table, parsed).map((value) => push(value)),
    ];
    try {
      await this.options.db.$executeRawUnsafe(
        `INSERT INTO ${quoteIdentifier(table.tableName)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${values.join(', ')})`,
        ...params,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ExtensionUniqueViolation(`唯一约束冲突：${model.kind}`);
      }
      throw error;
    }
    const row = await this.fetchRow(registered, String(params[0]), true);
    return toInstance<T>(row ?? {});
  }

  async update<T>(
    model: CustomModelDefinition,
    name: string,
    spec: T,
    opts?: { expectedVersion?: number },
  ): Promise<ExtensionInstance<T>> {
    const registered = this.resolve(model);
    const currentRow = await this.fetchRow(registered, name);
    if (!currentRow) throw new ExtensionNotFound(name);
    const current = toInstance<T>(currentRow);
    const parsed = this.validate(model, spec);
    const table = registered.table;
    this.assertOwnerContext(table);

    const params: unknown[] = [];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const sets = [
      `"spec" = ${push(JSON.stringify(parsed))}::jsonb`,
      `"version" = "version" + 1`,
      `"updated_at" = ${push(new Date())}`,
      ...table.columns.map(
        (column, index) =>
          `${quoteIdentifier(column.column)} = ${push(this.indexValues(table, parsed)[index])}`,
      ),
    ];
    const clauses = [`"id" = ${push(name)}`];
    const expectedVersion = opts?.expectedVersion ?? current.version;
    clauses.push(`"version" = ${push(expectedVersion)}`);
    if (table.scoped && this.options.ownerId) {
      clauses.push(`"owner_id" = ${push(this.options.ownerId)}`);
    }
    const updated = await this.options.db
      .$executeRawUnsafe(
        `UPDATE ${quoteIdentifier(table.tableName)} SET ${sets.join(', ')} WHERE ${joinClauses(clauses)}`,
        ...params,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ExtensionUniqueViolation(`唯一约束冲突：${model.kind}`);
        }
        throw error;
      });
    if (updated === 0) {
      const still = await this.fetchRow(registered, name, true);
      if (!still) throw new ExtensionNotFound(name);
      throw new ExtensionVersionConflict(name);
    }
    const row = await this.fetchRow(registered, name, true);
    return toInstance<T>(row ?? {});
  }

  async updateWhere(
    model: CustomModelDefinition,
    where: ExtensionWhere,
    patch: ExtensionPatch,
  ): Promise<{ updated: number }> {
    const registered = this.resolve(model);
    const table = registered.table;
    this.assertOwnerContext(table);
    const params: unknown[] = [];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const sets: string[] = [];
    const specPairs: string[] = [];
    const columnByField = new Map(table.columns.map((column) => [column.field, column]));

    for (const [field, operation] of Object.entries(patch)) {
      if (field === 'status') {
        if (!('set' in operation)) {
          throw new ExtensionValidationError('status 仅支持 set 操作');
        }
        sets.push(`"status" = ${push(JSON.stringify(operation.set))}::jsonb`);
        continue;
      }
      const column = columnByField.get(field);
      if (!column) throw new ExtensionValidationError(`不可更新的字段：${field}`);
      if ('set' in operation) {
        const value = coerceIndexValue(column, operation.set);
        sets.push(`${quoteIdentifier(column.column)} = ${push(value)}`);
        specPairs.push(
          `${push(field)}::text, ${push(jsonValue(value as string | number | boolean | null))}::jsonb`,
        );
      } else {
        if (column.type !== 'integer' && column.type !== 'number') {
          throw new ExtensionValidationError(`字段 ${field} 不支持自增/自减`);
        }
        if ('inc' in operation) {
          sets.push(`${quoteIdentifier(column.column)} = ${quoteIdentifier(column.column)} + ${push(operation.inc)}`);
          specPairs.push(
            `${push(field)}::text, to_jsonb((("spec" ->> ${push(field)})::numeric + ${push(operation.inc)}))`,
          );
        } else {
          sets.push(`${quoteIdentifier(column.column)} = ${quoteIdentifier(column.column)} - ${push(operation.dec)}`);
          specPairs.push(
            `${push(field)}::text, to_jsonb((("spec" ->> ${push(field)})::numeric - ${push(operation.dec)}))`,
          );
        }
      }
    }
    if (sets.length === 0 && specPairs.length === 0) {
      throw new ExtensionValidationError('更新内容为空');
    }
    if (specPairs.length > 0) {
      // One combined assignment: Postgres rejects assigning the same column twice.
      sets.push(`"spec" = "spec" || jsonb_build_object(${specPairs.join(', ')})`);
    }
    sets.push(`"version" = "version" + 1`);
    sets.push(`"updated_at" = ${push(new Date())}`);

    const clauses = [IS_DELETED];
    if (table.scoped && this.options.ownerId) {
      clauses.push(`"owner_id" = ${push(this.options.ownerId)}`);
    }
    const predicate = compileWhere(table, where, params);
    if (predicate) clauses.push(predicate);

    const updated = await this.options.db.$executeRawUnsafe(
      `UPDATE ${quoteIdentifier(table.tableName)} SET ${sets.join(', ')} WHERE ${joinClauses(clauses)}`,
      ...params,
    );
    return { updated };
  }

  async delete(model: CustomModelDefinition, name: string): Promise<void> {
    const registered = this.resolve(model);
    const row = await this.fetchRow(registered, name, true);
    if (!row) throw new ExtensionNotFound(name);
    const instance = toInstance(row);
    const table = registered.table;
    this.assertOwnerContext(table);
    const finalizers = model.finalizers ?? [];

    if (finalizers.length > 0) {
      if (!instance.deletionTimestamp) {
        const params: unknown[] = [];
        const push = (value: unknown): string => {
          params.push(value);
          return `$${params.length}`;
        };
        const clauses = [`"id" = ${push(name)}`];
        if (table.scoped && this.options.ownerId) {
          clauses.push(`"owner_id" = ${push(this.options.ownerId)}`);
        }
        await this.options.db.$executeRawUnsafe(
          `UPDATE ${quoteIdentifier(table.tableName)} SET "deleted_at" = ${push(new Date())}, "version" = "version" + 1 WHERE ${joinClauses(clauses)}`,
          ...params,
        );
      }
      for (const finalizerName of finalizers) {
        const handler = this.options.finalizers.get(
          this.options.pluginId,
          model.kind,
          finalizerName,
        );
        if (!handler) {
          throw new ExtensionValidationError(`finalizer 未注册：${finalizerName}`);
        }
        await handler(instance);
      }
    }

    const params: unknown[] = [];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const clauses = [`"id" = ${push(name)}`];
    if (table.scoped && this.options.ownerId) {
      clauses.push(`"owner_id" = ${push(this.options.ownerId)}`);
    }
    await this.options.db.$executeRawUnsafe(
      `DELETE FROM ${quoteIdentifier(table.tableName)} WHERE ${joinClauses(clauses)}`,
      ...params,
    );
  }

  registerFinalizer(
    model: CustomModelDefinition,
    name: string,
    handler: ExtensionFinalizer,
  ): void {
    const registered = this.resolve(model);
    if (!(model.finalizers ?? []).includes(name)) {
      throw new ExtensionValidationError(`模型 ${model.kind} 未声明 finalizer ${name}`);
    }
    this.options.finalizers.set(registered.pluginId, model.kind, name, handler);
  }
}

/** Validate one declared index value against its column type. */
function coerceIndexValue(column: ExtensionColumn, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  switch (column.type) {
    case 'string':
      if (typeof value !== 'string') {
        throw new ExtensionValidationError(`字段 ${column.field} 应为字符串`);
      }
      return value;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new ExtensionValidationError(`字段 ${column.field} 应为整数`);
      }
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ExtensionValidationError(`字段 ${column.field} 应为数字`);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new ExtensionValidationError(`字段 ${column.field} 应为布尔值`);
      }
      return value;
  }
}

/** Serialise a scalar to a JSON literal usable with a `::jsonb` cast. */
function jsonValue(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  return JSON.stringify(value);
}

export function createExtensionClient(options: ExtensionClientOptions): ExtensionClient {
  return new ExtensionClientImpl(options);
}

/** Re-exported for callers that need the deleted-row marker. */
export { IS_DELETED, NOT_DELETED };
