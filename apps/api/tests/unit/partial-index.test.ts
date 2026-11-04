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

describe('索引声明只允许追加（升级兼容性）', () => {
  /**
   * 索引名由**声明位置**生成（`schema.ts`：`idx_${tableName}_${position+1}`），
   * 而迁移器按**名字**匹配已有索引。
   *
   * 于是「把新索引插到数组中间」= 让所有已有索引的编号整体后移一位 = 每个
   * 位置都被判定为「定义已变更」。而收紧唯一性会被 `isRelaxation` 拒绝，
   * 结果是**已部署的库升级时 API 启动即崩**。
   *
   * 真实事故：给 store/service-instance 加 `providerServiceId` 唯一索引时插在
   * 了 `expiresAtMs` 之前，本地库报
   * `模型 store/service-instance 的索引 idx_ext_store_service-instance_7 定义已变更`。
   * 本地是新建库所以看不出来，生产库一定中招。
   */
  const storeData = readFileSync(
    path.join(root, '../../packages/plugins/store/src/data.ts'),
    'utf8',
  );

  it('providerServiceId 的唯一索引必须排在所有既有索引之后', () => {
    const block = storeData.slice(storeData.indexOf("kind: 'store/service-instance'"));
    const indexesStart = block.indexOf('indexes: [');
    const indexesEnd = block.indexOf('  ],', indexesStart);
    const indexes = block.slice(indexesStart, indexesEnd);

    const positions = [...indexes.matchAll(/\{\s*\n?\s*fields: \['(\w+)'\]/g)].map((m) => m[1]);
    // 唯一的那个索引必须是最后一个声明
    expect(indexes.indexOf('unique: true')).toBeGreaterThan(
      indexes.indexOf("fields: ['expiryStage']"),
    );
  });

  it('既有索引的相对顺序没有被重排', () => {
    const block = storeData.slice(storeData.indexOf("kind: 'store/service-instance'"));
    const indexesStart = block.indexOf('indexes: [');
    const indexesEnd = block.indexOf('  ],', indexesStart);
    const indexes = block.slice(indexesStart, indexesEnd);

    // 这些是 0.1.x 就已存在的声明顺序，任何一个移动都会让已部署库崩掉。
    const legacy = [
      'userId',
      'orderId',
      'productId',
      'state',
      'providerId',
      'providerServiceId',
      'expiresAtMs',
      'expiryStage',
    ];
    const seen: string[] = [];
    for (const m of indexes.matchAll(/fields: \['(\w+)'\]/g)) {
      const field = m[1]!;
      if (legacy.includes(field) && !seen.includes(field)) seen.push(field);
    }
    expect(seen).toEqual(legacy);
  });
});

describe('唯一索引的重复检查必须带上部分索引谓词', () => {
  const migrator = readFileSync(path.join(root, 'src/extensions/migrator.ts'), 'utf8');

  /**
   * `assertNoDuplicates` 原来只查 `WHERE deleted_at IS NULL`，把 NULL 行也算进
   * 重复组。而部分唯一索引 `WHERE col IS NOT NULL` **根本不约束 NULL 行**。
   *
   * 真实事故：本地库 4 条 service-instance 里 3 条 `providerServiceId IS NULL`，
   * 被当成「3 条重复」，迁移抛错，API 启动即崩 —— 而数据其实完全合法。
   */
  it('把 whereNotNull 转成 SQL 谓词再查重', () => {
    const fn = migrator.slice(migrator.indexOf('async function assertNoDuplicates'));
    const body = fn.slice(0, fn.indexOf('\n}'));

    expect(body).toContain('whereNotNull');
    expect(body).toMatch(/IS NOT NULL/);
  });

  it('谓词与 createIndexSql 用的是同一组列', () => {
    const fn = migrator.slice(migrator.indexOf('async function assertNoDuplicates'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    // 必须遍历 index.columns 生成谓词，不能写死某个列名
    expect(body).toMatch(/index\.columns\.map/);
  });
});

describe('多列声明部分索引必须报错，不能静默降级', () => {
  /**
   * `where: { kind: 'notNull' }` 的谓词只支持单列。原实现写成
   * `fields.length === 1 ? { whereNotNull: true } : {}` —— 多列时**静默丢掉**
   * 谓词，于是：
   *
   *     声明：UNIQUE (a, b) WHERE a IS NOT NULL   （NULL 行不参与）
   *     实际：UNIQUE (a, b)                        （NULL 行也参与）
   *
   * 语义正好反过来，而且不报错。插件作者以为声明了宽松约束，线上拿到严格
   * 约束，要等到某次写入撞上 NULL 重复才暴露。
   */
  it('多列 + where.notNull 抛错', () => {
    expect(() =>
      compileTable({
        kind: 'test/multi',
        schema: { a: 'string', b: 'string' },
        indexes: [
          {
            fields: ['a', 'b'],
            types: { a: 'string', b: 'string' },
            unique: true,
            where: { kind: 'notNull' },
          },
        ],
      } as never),
    ).toThrow(/只支持单列/);
  });

  it('单列 + where.notNull 仍然生成谓词', () => {
    const t = compileTable({
      kind: 'test/single',
      schema: { a: 'string' },
      indexes: [
        {
          fields: ['a'],
          types: { a: 'string' },
          unique: true,
          where: { kind: 'notNull' },
        },
      ],
    } as never);
    expect(t.indexes[0]?.whereNotNull).toBe(true);
    expect(createIndexSql(t.tableName, t.indexes[0]!)).toContain('IS NOT NULL');
  });

  it('多列但不声明 where 不受影响', () => {
    const t = compileTable({
      kind: 'test/plain',
      schema: { a: 'string', b: 'string' },
      indexes: [
        { fields: ['a', 'b'], types: { a: 'string', b: 'string' } },
      ],
    } as never);
    expect(t.indexes[0]?.whereNotNull).toBeUndefined();
    expect(createIndexSql(t.tableName, t.indexes[0]!)).not.toContain('IS NOT NULL');
  });
});
