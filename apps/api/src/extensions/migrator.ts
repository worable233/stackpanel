/**
 * Extension 引擎：DDL 迁移器（ADR-0009 §6 / PLAN-E1 §4.3–§4.4）。
 *
 * 只支持增量安全变更：建表、加可空列、增删非唯一索引、加唯一索引（先查重）、
 * 无损加宽类型（int4 → float8）。
 * 其余改类型 / 删列 / 改唯一性 / 改表名一律 {@link ExtensionUnsupportedMigration}。
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

/**
 * 允许**无损加宽**的类型变更（existing → declared）。
 *
 * 为什么需要：epoch 毫秒这类值（≈1.7e12）装不进 int4（上限 2.1e9），一旦某个
 * 模型把字段从 `integer` 改成 `number`，已部署实例的表里仍是 int4。若不支持加宽，
 * 升级会以「类型已变更」直接拒绝迁移，运维只能手工改库——比缺陷本身更难排查。
 *
 * 只放行**不会丢精度、不会截断**的方向：int4 → float8 对所有 int4 值都精确可表示。
 * 反向（float8 → int4）以及 text/boolean 之间的任何变更仍一律拒绝。
 */
const WIDENINGS: ReadonlyArray<readonly [string, string]> = [['integer', 'double precision']];

function isLosslessWidening(actual: string, declared: string): boolean {
  return WIDENINGS.some(([from, to]) => from === actual && to === declared);
}

interface ActualIndex {
  name: string;
  columns: string[];
  unique: boolean;
  /** 部分索引谓词是否为「该列非空」（见 `ModelIndex.where`）。 */
  whereNotNull: boolean;
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
    Array<{ name: string; unique: boolean; whereNotNull: boolean; columns: string[] }>
  >(
    `SELECT i.relname::text AS name,
            ix.indisunique AS "unique",
            -- 只识别内核自己会生成的那种谓词（单列 IS NOT NULL）。其它谓词
            -- 一律视为「非内核生成」，不参与相等判断 —— 这样不会被误认成
            -- 我们声明的索引，也不会被悄悄当成没问题。
            (pg_get_expr(ix.indpred, ix.indrelid) IS NOT NULL
             AND pg_get_expr(ix.indpred, ix.indrelid) ~ '^\\(?[a-z_][a-z0-9_]* IS NOT NULL\\)?$') AS "whereNotNull",
            array_agg(a.attname::text ORDER BY k.ord) AS columns
       FROM pg_class t
       JOIN pg_index ix ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE t.relname = $1 AND t.relkind = 'r'
      GROUP BY i.relname, ix.indisunique, ix.indpred, ix.indrelid`,
    tableName,
  );
  return rows.map((row) => ({
    name: row.name,
    columns: Array.isArray(row.columns) ? row.columns : [],
    unique: row.unique === true,
    whereNotNull: row.whereNotNull === true,
  }));
}

function sameIndex(left: ExtensionIndexSpec, right: ActualIndex): boolean {
  return (
    left.unique === right.unique &&
    (left.whereNotNull === true) === right.whereNotNull &&
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
      if (isLosslessWidening(type, TYPE_NAMES[column.type])) {
        // 无损加宽（int4 → float8）：就地 ALTER，保留既有数据。
        await db.$executeRawUnsafe(
          `ALTER TABLE ${quoteIdentifier(table.tableName)} ALTER COLUMN ${quoteIdentifier(column.column)} TYPE ${TYPE_NAMES[column.type]}`,
        );
        continue;
      }
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
      if (sameIndex(index, existing)) continue;
      /**
       * 索引定义变了。
       *
       * E1 原先一律拒绝重建，因为「收紧唯一性」可能让已有数据无法满足约束。
       * 但有一类变更是**纯放宽**的：`UNIQUE (col)` → `UNIQUE (col) WHERE col
       * IS NOT NULL`。新集合是新集合的子集，凡是旧索引能接受的行新索引必然也
       * 接受，重建不会失败，也不会丢数据。
       *
       * 必须支持它，否则「给可空列加部分唯一索引」这个声明在**已部署**的库上
       * 永远生效不了：升级只是报个错，管理员并不知道该手工删哪个索引。
       */
      const isRelaxation =
        existing.unique &&
        index.unique &&
        existing.whereNotNull === false &&
        index.whereNotNull === true;
      if (!isRelaxation) {
        throw new ExtensionUnsupportedMigration(
          `模型 ${table.kind} 的索引 ${index.name} 定义已变更（E1 不支持重建索引）`,
        );
      }
      await db.$executeRawUnsafe(dropIndexSql(existing.name));
      await db.$executeRawUnsafe(createIndexSql(table.tableName, index));
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
        // 跨进程串行。`migrationLocks` 只在**本进程**内有效，而 compose 里 api 与
        // worker 是两个容器（pid 都是 1）、共用同一个数据库，首次启动时同时激活
        // 内置插件：两条 `CREATE TABLE IF NOT EXISTS` 并发会撞 PostgreSQL 的
        // `23505 duplicate key value violates unique constraint
        // "pg_type_typname_nsp_index"`（隐式 row type 同名），其中一个进程直接退出。
        // 实测：全新数据卷 `up -d` 偶发 worker 启动失败。
        // `$executeRawUnsafe` 而不是 `$queryRawUnsafe`：`pg_advisory_xact_lock`
        // 返回 `void`，Prisma 读结果集时会报「Failed to deserialize column of type
        // 'void'」。executeRaw 只看影响行数，不反序列化返回值。
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          `stackpanel.extension.${table.kind}`,
        );
        // 拿到锁后必须**重新读一次**：另一个进程可能刚刚建完表并写好了元数据。
        const current = await tx.extensionSchema.findUnique({ where: { kind: table.kind } });
        if (current && current.definitionHash === hash && current.tableName === table.tableName) {
          return;
        }
        if (!current) {
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
