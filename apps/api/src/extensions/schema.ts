/**
 * Extension 引擎：表/列/索引的命名与 DDL 生成（ADR-0009 §2 / PLAN-E1 §3.2）。
 *
 * 所有标识符都由引擎从**受约束的输入**生成（kind、字段名、声明顺序），并且
 * 在拼进 SQL 前一律经过 {@link assertIdentifier} 白名单校验 + 双引号包裹。
 * 模型定义里的原始字符串绝不会直接进 SQL。
 */

import { createHash } from 'node:crypto';
import type { CustomModelDefinition, ModelFieldType } from '@stackpanel/sdk';

/** 引擎固定列（与 ADR-0009 §2 对齐；时间为 PostgreSQL timestamptz）。 */
export const FIXED_COLUMNS = [
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
  'deleted_at',
] as const;

/** 内建可查询字段 → 列名。 */
export const BUILTIN_FIELDS: Record<string, string> = {
  name: 'id',
  ownerId: 'owner_id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const SQL_TYPES: Record<ModelFieldType, string> = {
  string: 'TEXT',
  integer: 'INTEGER',
  number: 'DOUBLE PRECISION',
  boolean: 'BOOLEAN',
};

/** One declared index field, materialised as a real column. */
export interface ExtensionColumn {
  /** Payload path declared in `indexes[].fields`. */
  field: string;
  /** Generated column name (`f_<field>`). */
  column: string;
  type: ModelFieldType;
}

/** One generated index. */
export interface ExtensionIndexSpec {
  name: string;
  columns: string[];
  unique: boolean;
}

/** Compiled, SQL-ready shape of one declared model. */
export interface ExtensionTable {
  kind: string;
  tableName: string;
  scoped: boolean;
  columns: ExtensionColumn[];
  indexes: ExtensionIndexSpec[];
}

/** 标识符白名单：引擎生成的名字必须匹配。 */
export function assertIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`Extension 标识符非法：${name}`);
  }
  return name;
}

export function quoteIdentifier(name: string): string {
  return `"${assertIdentifier(name)}"`;
}

export function tableNameFor(kind: string): string {
  return assertIdentifier(`ext_${kind.replace('/', '_')}`);
}

export function ownerIndexName(tableName: string): string {
  return assertIdentifier(`idx_${tableName}_owner`);
}

/** Compile a declarative model into its physical table shape. */
export function compileTable(definition: CustomModelDefinition): ExtensionTable {
  const tableName = tableNameFor(definition.kind);
  const columns: ExtensionColumn[] = [];
  const columnByField = new Map<string, ExtensionColumn>();
  const indexes: ExtensionIndexSpec[] = [];

  (definition.indexes ?? []).forEach((index, position) => {
    const fields: string[] = [];
    for (const field of index.fields) {
      const type = index.types[field];
      if (!type) throw new Error(`模型 ${definition.kind} 的索引字段 ${field} 缺少类型`);
      const existing = columnByField.get(field);
      if (existing && existing.type !== type) {
        throw new Error(`模型 ${definition.kind} 的字段 ${field} 存在冲突的类型声明`);
      }
      let column = existing;
      if (!column) {
        column = {
          field,
          column: assertIdentifier(`f_${field}`),
          type,
        };
        columns.push(column);
        columnByField.set(field, column);
      }
      fields.push(column.column);
    }
    indexes.push({
      name: assertIdentifier(`idx_${tableName}_${position + 1}`),
      columns: fields,
      unique: index.unique === true,
    });
  });

  const scoped = definition.scoped === true;
  if (scoped) {
    indexes.push({ name: ownerIndexName(tableName), columns: ['owner_id'], unique: false });
  }

  return { kind: definition.kind, tableName, scoped, columns, indexes };
}

/**
 * Stable hash of the table-affecting parts of a model. Changing a column type,
 * a column set, or an index (including its generated name, so reordering
 * declarations is detected) changes the hash and triggers a diff.
 */
export function tableHash(table: ExtensionTable): string {
  const payload = JSON.stringify({
    version: 1,
    scoped: table.scoped,
    columns: table.columns.map((column) => [column.field, column.type]),
    indexes: table.indexes.map((index) => [index.name, index.columns, index.unique]),
  });
  return createHash('sha256').update(payload).digest('hex');
}

function columnDefinition(column: ExtensionColumn): string {
  return `${quoteIdentifier(column.column)} ${SQL_TYPES[column.type]}`;
}

/** `CREATE TABLE [IF NOT EXISTS]` for a compiled model. */
export function createTableSql(table: ExtensionTable, ifNotExists = true): string {
  const lines = [
    `${quoteIdentifier('id')} TEXT PRIMARY KEY`,
    `${quoteIdentifier('owner_id')} TEXT`,
    `${quoteIdentifier('version')} INTEGER NOT NULL DEFAULT 1`,
    `${quoteIdentifier('spec')} JSONB NOT NULL`,
    `${quoteIdentifier('status')} JSONB`,
    `${quoteIdentifier('labels')} JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `${quoteIdentifier('annotations')} JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `${quoteIdentifier('finalizers')} JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `${quoteIdentifier('created_at')} TIMESTAMPTZ NOT NULL`,
    `${quoteIdentifier('updated_at')} TIMESTAMPTZ NOT NULL`,
    `${quoteIdentifier('deleted_at')} TIMESTAMPTZ`,
    ...table.columns.map(columnDefinition),
  ];
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quoteIdentifier(table.tableName)} (\n  ${lines.join(',\n  ')}\n)`;
}

export function addColumnSql(tableName: string, column: ExtensionColumn): string {
  return `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN IF NOT EXISTS ${columnDefinition(column)}`;
}

export function createIndexSql(tableName: string, index: ExtensionIndexSpec): string {
  const kind = index.unique ? 'UNIQUE INDEX' : 'INDEX';
  const columns = index.columns.map(quoteIdentifier).join(', ');
  return `CREATE ${kind} IF NOT EXISTS ${quoteIdentifier(index.name)} ON ${quoteIdentifier(tableName)} (${columns})`;
}

export function dropIndexSql(indexName: string): string {
  return `DROP INDEX IF EXISTS ${quoteIdentifier(indexName)}`;
}

export function dropTableSql(tableName: string): string {
  return `DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`;
}
