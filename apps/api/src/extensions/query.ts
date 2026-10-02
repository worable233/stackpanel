/**
 * Extension 引擎：`where` / `orderBy` → 参数化 SQL（ADR-0009 §3 / PLAN-E1 §4.1）。
 *
 * 只有声明过的索引字段与内建字段（name/ownerId/createdAt/updatedAt）可作为
 * 查询条件；其余一律 {@link ExtensionUnknownField}。值全部走占位符，字段名只
 * 经由白名单映射到引擎生成的列名。
 */

import type { ExtensionWhere } from '@stackpanel/sdk';
import { ExtensionUnknownField, ExtensionValidationError } from '@stackpanel/sdk';
import { BUILTIN_FIELDS, quoteIdentifier, type ExtensionTable } from './schema.ts';

export interface ResolvedColumn {
  column: string;
  /** Declared type when it is a model index field; undefined for built-ins. */
  type: 'string' | 'integer' | 'number' | 'boolean' | undefined;
}

/** Map a query field to its physical column, or fail with UnknownField. */
export function resolveQueryColumn(table: ExtensionTable, field: string): ResolvedColumn {
  const builtin = BUILTIN_FIELDS[field];
  if (builtin) return { column: builtin, type: undefined };
  const declared = table.columns.find((column) => column.field === field);
  if (!declared) throw new ExtensionUnknownField(field);
  return { column: declared.column, type: declared.type };
}

/** Escape LIKE wildcards so user input is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Compile a predicate into a SQL clause, pushing bound values onto `params`.
 * The returned string may be empty (no conditions).
 */
export function compileWhere(
  table: ExtensionTable,
  where: ExtensionWhere | undefined,
  params: unknown[],
): string {
  const clauses: string[] = [];
  for (const [field, condition] of Object.entries(where ?? {})) {
    const { column, type } = resolveQueryColumn(table, field);
    const quoted = quoteIdentifier(column);

    if ('eq' in condition) {
      const value = condition.eq;
      if (value === null || value === undefined) {
        clauses.push(`${quoted} IS NULL`);
      } else {
        params.push(value);
        clauses.push(`${quoted} = $${params.length}`);
      }
    }
    if ('in' in condition) {
      const values = condition.in ?? [];
      if (values.length === 0) {
        clauses.push('FALSE');
      } else {
        const placeholders = values.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        clauses.push(`${quoted} IN (${placeholders.join(', ')})`);
      }
    }
    for (const operator of ['gte', 'gt', 'lte', 'lt'] as const) {
      if (operator in condition) {
        params.push(condition[operator]);
        const symbol = { gte: '>=', gt: '>', lte: '<=', lt: '<' }[operator];
        clauses.push(`${quoted} ${symbol} $${params.length}`);
      }
    }
    if ('contains' in condition) {
      if (type && type !== 'string') {
        throw new ExtensionValidationError(`contains 仅支持字符串字段：${field}`);
      }
      params.push(`%${escapeLike(String(condition.contains))}%`);
      clauses.push(`${quoted} LIKE $${params.length} ESCAPE '\\'`);
    }
  }
  return clauses.join(' AND ');
}

/** Compile the ORDER BY clause; always ends with a stable `id` tiebreaker. */
export function compileOrderBy(
  table: ExtensionTable,
  orderBy: { field: string; desc?: boolean } | undefined,
): string {
  const parts: string[] = [];
  if (orderBy) {
    const { column } = resolveQueryColumn(table, orderBy.field);
    parts.push(`${quoteIdentifier(column)} ${orderBy.desc ? 'DESC' : 'ASC'}`);
  }
  if (!orderBy || orderBy.field !== 'name') {
    parts.push(`${quoteIdentifier('id')} ASC`);
  }
  return parts.join(', ');
}

/** Join non-empty clauses with AND. */
export function joinClauses(clauses: Array<string | undefined>): string {
  return clauses.filter((clause): clause is string => !!clause && clause.length > 0).join(' AND ');
}
