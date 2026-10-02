import { describe, expect, it } from 'vitest';
import { PluginError, defineModel } from '@stackpanel/sdk';
import {
  ExtensionNotFound,
  ExtensionUnknownField,
  ExtensionUnknownKind,
  ExtensionValidationError,
} from '@stackpanel/sdk';
import { z } from 'zod';
import {
  addColumnSql,
  compileTable,
  createIndexSql,
  createTableSql,
  tableHash,
  tableNameFor,
} from '../../src/extensions/schema.ts';

const base = z.object({ name: z.string(), slug: z.string(), order: z.number() });

describe('defineModel 校验（E1 DSL）', () => {
  it('拒绝嵌套路径的索引字段', () => {
    expect(() =>
      defineModel({
        kind: 'e1/a',
        label: 'A',
        schema: base,
        indexes: [{ fields: ['a.b'], types: { 'a.b': 'string' } }],
      }),
    ).toThrow(/嵌套路径/);
  });

  it('拒绝缺少显式类型的索引字段', () => {
    expect(() =>
      defineModel({
        kind: 'e1/a',
        label: 'A',
        schema: base,
        indexes: [{ fields: ['slug'], types: {} }],
      }),
    ).toThrow(/缺少显式类型/);
  });

  it('拒绝重复字段与未列出的类型声明', () => {
    expect(() =>
      defineModel({
        kind: 'e1/a',
        label: 'A',
        schema: base,
        indexes: [{ fields: ['slug', 'slug'], types: { slug: 'string' } }],
      }),
    ).toThrow(/重复/);
    expect(() =>
      defineModel({
        kind: 'e1/a',
        label: 'A',
        schema: base,
        indexes: [{ fields: ['slug'], types: { slug: 'string', other: 'string' } }],
      }),
    ).toThrow(/未列出的字段/);
  });

  it('拒绝非法的索引字段名', () => {
    expect(() =>
      defineModel({
        kind: 'e1/a',
        label: 'A',
        schema: base,
        indexes: [{ fields: ['drop table'], types: { 'drop table': 'string' } }],
      }),
    ).toThrow(/字段名非法/);
  });
});

describe('compileTable / DDL', () => {
  const model = defineModel({
    kind: 'e1/thing',
    label: '东西',
    schema: base,
    scoped: true,
    indexes: [
      { fields: ['slug'], types: { slug: 'string' }, unique: true },
      { fields: ['order'], types: { order: 'integer' } },
      { fields: ['name', 'order'], types: { name: 'string', order: 'integer' } },
    ],
  });

  it('生成稳定的表名、列名与索引名', () => {
    const table = compileTable(model);
    expect(table.tableName).toBe('ext_e1_thing');
    expect(table.columns.map((column) => column.column)).toEqual(['f_slug', 'f_order', 'f_name']);
    expect(table.indexes.map((index) => index.name)).toEqual([
      'idx_ext_e1_thing_1',
      'idx_ext_e1_thing_2',
      'idx_ext_e1_thing_3',
      'idx_ext_e1_thing_owner',
    ]);
    expect(table.indexes[0]).toEqual({
      name: 'idx_ext_e1_thing_1',
      columns: ['f_slug'],
      unique: true,
    });
  });

  it('哈希对列/索引/类型变化敏感，且稳定', () => {
    const hash = tableHash(compileTable(model));
    expect(tableHash(compileTable(model))).toBe(hash);
    const changed = defineModel({
      kind: 'e1/thing',
      label: '东西',
      schema: base,
      scoped: true,
      indexes: [{ fields: ['slug'], types: { slug: 'string' }, unique: false }],
    });
    expect(tableHash(compileTable(changed))).not.toBe(hash);
  });

  it('拒绝同一字段的冲突类型声明', () => {
    const conflict = defineModel({
      kind: 'e1/conflict',
      label: 'X',
      schema: base,
      indexes: [
        { fields: ['order'], types: { order: 'integer' } },
        { fields: ['order'], types: { order: 'string' } },
      ],
    });
    expect(() => compileTable(conflict)).toThrow(/冲突的类型声明/);
  });

  it('建表 SQL 使用真实列与 JSONB，且标识符全部双引号包裹', () => {
    const table = compileTable(model);
    const sql = createTableSql(table);
    expect(sql).toContain('"spec" JSONB NOT NULL');
    expect(sql).toContain('"f_slug" TEXT');
    expect(sql).toContain('"deleted_at" TIMESTAMPTZ');
    const orderColumn = table.columns.at(1);
    const uniqueIndex = table.indexes.at(0);
    if (!orderColumn || !uniqueIndex) throw new Error('预期 schema 含 order 列与首个唯一索引');
    expect(addColumnSql(table.tableName, orderColumn)).toContain(
      'ADD COLUMN IF NOT EXISTS "f_order" INTEGER',
    );
    expect(createIndexSql(table.tableName, uniqueIndex)).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_ext_e1_thing_1"',
    );
  });

  it('表名生成对斜杠安全，非法 kind 被拒绝', () => {
    expect(tableNameFor('catalog/category')).toBe('ext_catalog_category');
    expect(() => tableNameFor('bad name/x')).toThrow(/标识符非法/);
  });
});

describe('Extension 错误契约', () => {
  it('都是携带稳定 code 与状态码的 PluginError', () => {
    expect(new ExtensionUnknownKind('a/b')).toBeInstanceOf(PluginError);
    expect(new ExtensionUnknownKind('a/b').code).toBe('extension.unknown_kind');
    expect(new ExtensionUnknownKind('a/b').status).toBe(403);
    expect(new ExtensionUnknownField('x').code).toBe('extension.unknown_field');
    expect(new ExtensionNotFound('x').status).toBe(404);
    expect(new ExtensionValidationError('bad').status).toBe(422);
  });
});
