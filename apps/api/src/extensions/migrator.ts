/**
 * Extension 引擎：DDL 迁移器（ADR-0009 §6 / PLAN-E1 §4.3–§4.4）。
 *
 * 只支持增量安全变更：建表、加可空列、增删非唯一索引、加唯一索引（先查重）。
 * 改类型 / 删列 / 改唯一性 / 改表名一律 {@link ExtensionUnsupportedMigration}。
 *
 * 元表 `extension_schema` 记录定义哈希；哈希一致即跳过，不一致才做真实 diff。
 * DDL 只在激活 / 迁移期执行，且整段包在同一事务里（PostgreSQL 支持 DDL 回滚）。
 */

import type { CustomModelDefinition, ModelFieldType } from '@stackpanel/sdk';
import { ExtensionUnsupportedMigration } from '@stackpanel/sdk';
import type { PrismaClient } from '@stackpanel/db';
import {
  addColumnSql,
  compileTable,
  createIndexSql,
  createTableSql,
  dropIndexSql,
  quoteIdentifier,
  tableHash,
  type ExtensionIndexSpec,
  type ExtensionTable,
} from './schema.ts';

const TYPE_NAMES: Record<ModelFieldType, string> = {
  string: 'text',
  integer: 'integer',
  number: 'double precision',
  boolean: 'boolean',
};

interface ActualIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

/** Serialise per-kind migrations so concurrent activations cannot race. */
const migrationLocks = new Map<string, Promise<unknown>>();

function withKindLock<T>(kind: string, run: () => Promise<T>): Promise<T> {
  const previous = migrationLocks.get(kind) ?? Promise.resolve();
  const next = previous.then(run, run);
  migrationLocks.set(
    kind,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function readColumns(
  db: Pick<PrismaClient, '$queryRawUnsafe'>,
  tableName: string,
): Promise<Map<string, string>> {
  const rows = await db.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    tableName,
  );
  return new Map(rows.map((row) => [row.column_name, row.data_type]));
}

async function readIndexes(
  db: Pick<PrismaClient, '$queryRawUnsafe'>,
  tableName: string,
): Promise<ActualIndex[]> {
  const rows = await db.$queryRawUnsafe<
    Array<{ name: string; unique: boolean; columns: string[] }>
  >(
    `SELECT i.relname::text AS name,
            ix.indisunique AS "unique",
            array_agg(a.attname::text ORDER BY k.ord) AS columns
       FROM pg_class t
       JOIN pg_index ix ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE t.relname = $1 AND t.relkind = 'r'
      GROUP BY i.relname, ix.indisunique`,
    tableName,
  );
  return rows.map((row) => ({
    name: row.name,
    columns: Array.isArray(row.columns) ? row.columns : [],
    unique: row.unique === true,
  }));
}

function sameIndex(left: ExtensionIndexSpec, right: ActualIndex): boolean {
  return (
    left.unique === right.unique &&
    left.columns.length === right.columns.length &&
    left.columns.every((column, index) => column === right.columns[index])
  );
}

/** Reject a unique index when existing rows already collide on its columns. */
async function assertNoDuplicates(
  db: Pick<PrismaClient, '$queryRawUnsafe'>,
  table: ExtensionTable,
  index: ExtensionIndexSpec,
): Promise<void> {
  const columns = index.columns.map(quoteIdentifier).join(', ');
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${columns} FROM ${quoteIdentifier(table.tableName)}
      WHERE "deleted_at" IS NULL
      GROUP BY ${columns} HAVING COUNT(*) > 1 LIMIT 1`,
  );
  if (rows.length > 0) {
    throw new ExtensionUnsupportedMigration(
      `模型 ${table.kind} 的字段存在重复值，无法建立唯一索引 ${index.name}`,
    );
  }
}

/** Apply a hash-changing diff; refuse anything E1 cannot do safely. */
async function applyDiff(
  db: Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>,
  table: ExtensionTable,
): Promise<void> {
  const actualColumns = await readColumns(db, table.tableName);
  const declared = new Set(table.columns.map((column) => column.column));

  for (const column of table.columns) {
    const type = actualColumns.get(column.column);
    if (type === undefined) {
      await db.$executeRawUnsafe(addColumnSql(table.tableName, column));
    } else if (type !== TYPE_NAMES[column.type]) {
      throw new ExtensionUnsupportedMigration(
        `模型 ${table.kind} 的字段 ${column.field} 类型已变更（${type} → ${TYPE_NAMES[column.type]}）`,
      );
    }
  }
  for (const [columnName] of actualColumns) {
    if (columnName.startsWith('f_') && !declared.has(columnName)) {
      throw new ExtensionUnsupportedMigration(
        `模型 ${table.kind} 需要删除列 ${columnName}（E1 不支持）`,
      );
    }
  }

  const actualIndexes = await readIndexes(db, table.tableName);
  const desiredNames = new Set(table.indexes.map((index) => index.name));
  const prefix = `idx_${table.tableName}_`;

  for (const index of table.indexes) {
    const existing = actualIndexes.find((candidate) => candidate.name === index.name);
    if (existing) {
      if (!sameIndex(index, existing)) {
        throw new ExtensionUnsupportedMigration(
          `模型 ${table.kind} 的索引 ${index.name} 定义已变更（E1 不支持重建索引）`,
        );
      }
      continue;
    }
    if (index.unique) await assertNoDuplicates(db, table, index);
    await db.$executeRawUnsafe(createIndexSql(table.tableName, index));
  }
  for (const actual of actualIndexes) {
    if (actual.name.startsWith(prefix) && !desiredNames.has(actual.name)) {
      await db.$executeRawUnsafe(dropIndexSql(actual.name));
    }
  }
}

/**
 * Ensure every declared model has an up-to-date physical table. Runs the DDL in
 * one transaction per model, keyed by kind so concurrent activations serialise.
 */
export async function ensureExtensionModels(
  prisma: PrismaClient,
  pluginId: string,
  definitions: readonly CustomModelDefinition[] | undefined,
): Promise<ExtensionTable[]> {
  const tables: ExtensionTable[] = [];
  for (const definition of definitions ?? []) {
    const table = compileTable(definition);
    await withKindLock(table.kind, async () => {
      const hash = tableHash(table);
      const existing = await prisma.extensionSchema.findUnique({ where: { kind: table.kind } });
      if (existing && existing.definitionHash === hash && existing.tableName === table.tableName) {
        return;
      }
      await prisma.$transaction(async (tx) => {
        if (!existing) {
          await tx.$executeRawUnsafe(createTableSql(table));
          for (const index of table.indexes) {
            await tx.$executeRawUnsafe(createIndexSql(table.tableName, index));
          }
          await tx.extensionSchema.create({
            data: {
              kind: table.kind,
              pluginId,
              definitionHash: hash,
              tableName: table.tableName,
            },
          });
          return;
        }
        await applyDiff(tx, table);
        await tx.extensionSchema.update({
          where: { kind: table.kind },
          data: { pluginId, definitionHash: hash, tableName: table.tableName },
        });
      });
    });
    tables.push(table);
  }
  return tables;
}

/** Drop a model's physical table and forget its metadata (retention = delete). */
export async function dropExtensionTable(prisma: PrismaClient, table: ExtensionTable): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS ${quoteIdentifier(table.tableName)}`);
    await tx.extensionSchema.deleteMany({ where: { kind: table.kind } });
  });
}
