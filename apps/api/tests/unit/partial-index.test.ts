import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIndexSql, tableHash, compileTable } from '../../src/extensions/schema.ts';

/**
 * 部分唯一索引（`WHERE col IS NOT NULL`）。
 *
 * 起因：一个上游服务实例只能被绑定一次，而 `providerServiceId` 在普通购买的
 * 实例上是 NULL。PostgreSQL 认为多个 NULL 互不相等，所以
 * `UNIQUE (provider_service_id)` 让「重复绑定」在**应用层之外**完全没有约束，
 * 两个管理员同时点绑定会写出两条实例指向同一个上游服务。
 *
 * 正确的语义是「非空值之间唯一」——必须写成部分索引。内核原先只会生成
 * `UNIQUE (cols)`，所以这类需求无处表达。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function table(
  indexes: Array<{ fields: string[]; unique?: boolean; partial?: boolean }>,
) {
  return compileTable({
    kind: 'store/service-instance',
    label: '交付物',
    schema: { safeParse: () => ({ success: true }) } as never,
    indexes: indexes.map((entry) => ({
      fields: entry.fields,
      unique: entry.unique,
      types: Object.fromEntries(entry.fields.map((column) => [column, 'string' as const])),
      ...(entry.partial ? { where: { kind: 'notNull' as const } } : {}),
    })),
  } as never);
}

describe('createIndexSql', () => {
  const base = { name: 'idx_t_provider', columns: ['providerServiceId'], unique: true };

  it('emits the predicate only when asked', () => {
    expect(createIndexSql('t', base)).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_t_provider" ON "t" ("providerServiceId")',
    );
    expect(createIndexSql('t', { ...base, whereNotNull: true })).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_t_provider" ON "t" ("providerServiceId") WHERE "providerServiceId" IS NOT NULL',
    );
  });

  it('ignores the predicate for multi-column indexes', () => {
    // 谓词只对单列有明确语义；多列时静默忽略比生成 `WHERE a IS NOT NULL`
    // （悄悄漏掉 b）安全得多。
    const multi = { name: 'idx_m', columns: ['a', 'b'], unique: true, whereNotNull: true };
    expect(createIndexSql('t', multi)).not.toContain('WHERE');
  });

  it('rejects a hostile column name before it reaches DDL', () => {
    // 转义不是这里的防线：`assertIdentifier` 在更早的阶段就把非法标识符挡掉了，
    // 插件根本没有机会把引号/分号塞进 CREATE INDEX。
    expect(() =>
      createIndexSql('t', {
        name: 'idx_x',
        columns: ['weird"name'],
        unique: false,
        whereNotNull: true,
      }),
    ).toThrow(/标识符非法/);
  });
});

describe('predicate is part of the declared identity', () => {
  it('survives compilation for a single non-null column', () => {
    const declared = compileTable({
      kind: 'store/service-instance',
      label: '交付物',
      schema: { safeParse: () => ({ success: true }) } as never,
      indexes: [
        {
          fields: ['providerServiceId'],
          unique: true,
          types: { providerServiceId: 'string' },
          where: { kind: 'notNull' },
        },
      ],
    } as never);
    // 索引名由位置生成（`idx_<table>_<n>`），列名带 `f_` 前缀。
    const entry = declared.indexes.find((candidate) => candidate.unique);
    expect(entry?.whereNotNull).toBe(true);
    expect(entry?.columns).toEqual(['f_providerServiceId']);
  });

  it('leaves the predicate off when it was not declared', () => {
    const declared = compileTable({
      kind: 'store/service-instance',
      label: '交付物',
      schema: { safeParse: () => ({ success: true }) } as never,
      indexes: [
        { fields: ['providerServiceId'], unique: true, types: { providerServiceId: 'string' } },
      ],
    } as never);
    expect(declared.indexes.find((candidate) => candidate.unique)?.whereNotNull).toBeUndefined();
  });

  it('changes the table hash so the migrator notices', () => {
    // 如果哈希不含谓词，`UNIQUE (x)` → `UNIQUE (x) WHERE x IS NOT NULL` 会被
    // 判为「索引没变」，数据库里留着旧索引，声明与实际长期不一致且无报错。
    const plain = table([{ fields: ['x'], unique: true }]);
    const partial = table([{ fields: ['x'], unique: true, partial: true }]);
    expect(tableHash(plain)).not.toBe(tableHash(partial));
  });

  it('keeps the hash stable when nothing changes', () => {
    const once = table([{ fields: ['x'], unique: true, partial: true }]);
    const twice = table([{ fields: ['x'], unique: true, partial: true }]);
    expect(tableHash(once)).toBe(tableHash(twice));
  });
});

describe('migrator can upgrade a plain unique index to a partial one', () => {
  const migrator = readFileSync(path.join(root, 'src/extensions/migrator.ts'), 'utf8');

  it('reads the predicate from the catalog instead of guessing', () => {
    expect(migrator).toContain('pg_get_expr(ix.indpred, ix.indrelid)');
    expect(migrator).toContain('whereNotNull');
  });

  it('treats predicate-aware equality as the diff basis', () => {
    expect(migrator).toMatch(
      /\(left\.whereNotNull === true\) === right\.whereNotNull/,
    );
  });

  it('allows the relaxation but still refuses any tightening', () => {
    // 放宽 = 新集合是旧集合的子集，重建必然成功；收紧可能让已有数据不满足，
    // 必须继续拒绝并让人处理。
    expect(migrator).toContain('isRelaxation');
    expect(migrator).toContain('ExtensionUnsupportedMigration');
    const block = migrator.slice(migrator.indexOf('isRelaxation'));
    expect(block.slice(0, 400)).toContain('dropIndexSql');
  });
});
