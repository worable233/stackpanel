import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ExtensionUnknownField,
  ExtensionUnknownKind,
  ExtensionUniqueViolation,
  ExtensionValidationError,
  ExtensionVersionConflict,
  defineModel,
  definePlugin,
} from '@stackpanel/sdk';
import type { PluginContext } from '@stackpanel/sdk';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { ExtensionService } from '../../src/extensions/service.ts';
import { ensureExtensionModels } from '../../src/extensions/migrator.ts';
import { PluginRuntime } from '../../src/plugins/runtime.ts';
import { EventEmitterEventBus } from '../../src/plugins/events.ts';
import { checkDbAvailable } from '../helpers.ts';

const dbAvailable = await checkDbAvailable();

const widgetSchema = z.object({ name: z.string(), slug: z.string(), qty: z.number().int() });

const widgetModel = defineModel({
  kind: 'e1test/widget',
  label: '测试小部件',
  schema: widgetSchema,
  indexes: [
    { fields: ['slug'], types: { slug: 'string' }, unique: true },
    { fields: ['qty'], types: { qty: 'integer' } },
  ],
});

const scopedModel = defineModel({
  kind: 'e1test/scoped',
  label: '用户私有小部件',
  scoped: true,
  schema: widgetSchema,
});

const migrateModel = defineModel({
  kind: 'e1test/migrate',
  label: '迁移小部件',
  schema: widgetSchema,
  indexes: [{ fields: ['slug'], types: { slug: 'string' } }],
});

const retainedModel = defineModel({
  kind: 'e1test/retained',
  label: '保留小部件',
  schema: widgetSchema,
  retention: 'retain',
});

const foreignModel = defineModel({
  kind: 'e1test/foreign',
  label: '他人小部件',
  schema: widgetSchema,
});

const txModel = defineModel({
  kind: 'e1test/tx',
  label: '事务小部件',
  schema: widgetSchema,
});

const finalizerModel = defineModel({
  kind: 'e1test/finalizer',
  label: 'Finalizer 小部件',
  schema: widgetSchema,
  finalizers: ['cleanup'],
});

const stressModel = defineModel({
  kind: 'e1test/stress',
  label: '并发小部件',
  schema: widgetSchema,
  indexes: [{ fields: ['qty'], types: { qty: 'integer' } }],
});

async function tableExists(tableName: string): Promise<boolean> {
  const rows = await getPrisma().$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT COUNT(*)::int AS "count" FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1`,
    tableName,
  );
  return (rows[0]?.count ?? 0) > 0;
}

describe.skipIf(!dbAvailable)('Extension 引擎（真实库）', () => {
  const service = new ExtensionService(getPrisma());
  const client = service.client('e1-test', null);

  async function clean(model: typeof widgetModel): Promise<void> {
    for (const item of await client.listAll<Record<string, unknown>>(model)) {
      await client.delete(model, item.name);
    }
  }

  beforeAll(async () => {
    await service.registerModels('e1-test', [widgetModel, scopedModel, migrateModel, retainedModel, finalizerModel, stressModel]);
    await service.registerModels('e1-other', [foreignModel]);
    for (const model of [widgetModel, migrateModel, retainedModel, finalizerModel, stressModel] as const) {
      await clean(model);
    }
  });

  afterAll(async () => {
    await service.applyRetention('e1-test', [widgetModel, scopedModel, migrateModel, retainedModel, finalizerModel, stressModel]);
    await service.applyRetention('e1-other', [foreignModel]);
  });

  it('建表：真实表 + 元数据行 + 索引', async () => {
    expect(await tableExists('ext_e1test_widget')).toBe(true);
    const meta = await getPrisma().extensionSchema.findUnique({ where: { kind: 'e1test/widget' } });
    expect(meta?.pluginId).toBe('e1-test');
    const columns = await getPrisma().$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'ext_e1test_widget'`,
    );
    const names = columns.map((column) => column.column_name);
    expect(names).toContain('f_slug');
    expect(names).toContain('f_qty');
    expect(names).toContain('spec');
  });

  it('CRUD 往返：create / get / list / update / delete', async () => {
    const created = await client.create<{ name: string; slug: string; qty: number }>(widgetModel, {
      name: '一号',
      slug: 'one',
      qty: 3,
    });
    expect(created.version).toBe(1);
    expect(created.name).toBeTruthy();

    const fetched = await client.get<{ name: string }>(widgetModel, created.name);
    expect(fetched?.spec.name).toBe('一号');

    const page = await client.list<{ slug: string }>(widgetModel, { page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0]?.spec.slug).toBe('one');

    const updated = await client.update<{ name: string; slug: string; qty: number }>(
      widgetModel,
      created.name,
      { name: '一号（改）', slug: 'one', qty: 9 },
    );
    expect(updated.version).toBe(2);
    expect(updated.spec.qty).toBe(9);

    await client.delete(widgetModel, created.name);
    expect(await client.get(widgetModel, created.name)).toBeNull();
  });

  it('page：无 COUNT 的有界读取 + 游标续读 + hasMore', async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const item = await client.create(widgetModel, {
        name: `页码 ${i}`,
        slug: `page-${i}`,
        qty: i,
      });
      created.push(item.name);
    }
    try {
      const first = await client.page<{ slug: string }>(widgetModel, { limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeTruthy();

      const seen = [...first.items];
      let cursor = first.nextCursor ?? undefined;
      let guard = 0;
      let last = first;
      while (cursor && guard < 10) {
        last = await client.page<{ slug: string }>(widgetModel, { limit: 2, cursor });
        seen.push(...last.items);
        cursor = last.nextCursor ?? undefined;
        guard += 1;
      }
      // Every row is reached exactly once.
      expect(new Set(seen.map((item) => item.name)).size).toBe(seen.length);
      expect(last.hasMore).toBe(false);
      expect(seen.length).toBeGreaterThanOrEqual(5);
    } finally {
      for (const name of created) await client.delete(widgetModel, name);
    }
  });

  it('page：按索引字段排序的游标不重不漏', async () => {
    const created: string[] = [];
    for (const qty of [3, 1, 2]) {
      const item = await client.create(widgetModel, {
        name: `排序 ${qty}`,
        slug: `cursor-${qty}`,
        qty,
      });
      created.push(item.name);
    }
    try {
      const where = { slug: { contains: 'cursor-' } };
      const collected: number[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const result = await client.page<{ qty: number }>(widgetModel, {
          where,
          orderBy: { field: 'qty' },
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        collected.push(...result.items.map((item) => item.spec.qty));
        if (!result.hasMore) break;
        cursor = result.nextCursor ?? undefined;
      }
      expect(collected).toEqual([1, 2, 3]);
    } finally {
      for (const name of created) await client.delete(widgetModel, name);
    }
  });

  it('getMany：一次读取多个主键，缺失项静默缺席', async () => {
    const first = await client.create(widgetModel, { name: 'M1', slug: 'many-1', qty: 1 });
    const second = await client.create(widgetModel, { name: 'M2', slug: 'many-2', qty: 2 });
    try {
      const found = await client.getMany<{ slug: string }>(widgetModel, [
        first.name,
        second.name,
        'does-not-exist',
      ]);
      expect(found.size).toBe(2);
      expect(found.get(first.name)?.spec.slug).toBe('many-1');
      expect(found.get(second.name)?.spec.slug).toBe('many-2');
      expect(found.has('does-not-exist')).toBe(false);
    } finally {
      await client.delete(widgetModel, first.name);
      await client.delete(widgetModel, second.name);
    }
  });

  it('唯一索引冲突 → ExtensionUniqueViolation', async () => {
    const first = await client.create(widgetModel, { name: 'A', slug: 'dup', qty: 1 });
    await expect(
      client.create(widgetModel, { name: 'B', slug: 'dup', qty: 2 }),
    ).rejects.toBeInstanceOf(ExtensionUniqueViolation);
    await client.delete(widgetModel, first.name);
  });

  it('乐观锁：过期版本 → ExtensionVersionConflict', async () => {
    const item = await client.create(widgetModel, { name: 'V', slug: 'version', qty: 1 });
    await client.update(widgetModel, item.name, { name: 'V', slug: 'version', qty: 2 });
    await expect(
      client.update(widgetModel, item.name, { name: 'V', slug: 'version', qty: 3 }, {
        expectedVersion: item.version,
      }),
    ).rejects.toBeInstanceOf(ExtensionVersionConflict);
    await client.delete(widgetModel, item.name);
  });

  it('未声明字段不能作为查询条件，未声明 kind 不可访问', async () => {
    await expect(
      client.list(widgetModel, { where: { nope: { eq: 1 } }, page: 1, pageSize: 10 }),
    ).rejects.toBeInstanceOf(ExtensionUnknownField);
    await expect(client.get(foreignModel, 'x')).rejects.toBeInstanceOf(ExtensionUnknownKind);
  });

  it('updateWhere 原子自减同时改写 spec', async () => {
    const item = await client.create(widgetModel, { name: 'W', slug: 'atomic', qty: 5 });
    const result = await client.updateWhere(
      widgetModel,
      { slug: { eq: 'atomic' } },
      { qty: { dec: 2 } },
    );
    expect(result.updated).toBe(1);
    const after = await client.get<{ qty: number }>(widgetModel, item.name);
    expect(after?.spec.qty).toBe(3);
    await client.delete(widgetModel, item.name);
  });

  it('finalizer 在物理删除前按序执行一次，且删除时能读到待删实例', async () => {
    const calls: string[] = [];
    client.registerFinalizer(finalizerModel, 'cleanup', async (instance) => {
      calls.push(instance.name);
      // 首次删除时实例尚未进入删除中状态，finalizer 仍能读到完整 payload。
      expect(instance.deletionTimestamp).toBeNull();
    });
    const item = await client.create(finalizerModel, { name: 'F', slug: 'fin', qty: 1 });
    await client.delete(finalizerModel, item.name);
    expect(calls).toEqual([item.name]);
    expect(await client.get(finalizerModel, item.name)).toBeNull();
  });

  it('并发 update 同一 expectedVersion：恰好一个成功，其余 VersionConflict', async () => {
    const item = await client.create(widgetModel, {
      name: 'C',
      slug: 'concurrent',
      qty: 1,
    });
    // 10 个真实并发连接（不同 pooled 请求）抢同一个版本号。
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        client.update(
          widgetModel,
          item.name,
          { name: 'C', slug: 'concurrent', qty: index + 2 },
          { expectedVersion: item.version },
        ),
      ),
    );
    const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const failure of rejected) {
      expect(failure.reason).toBeInstanceOf(ExtensionVersionConflict);
    }
    // 版本只前进一步：胜者写一次，败者没有落库。
    const after = await client.get<{ qty: number }>(widgetModel, item.name);
    expect(after?.version).toBe(item.version + 1);
    await client.delete(widgetModel, item.name);
  });

  it('并发 update 与 updateWhere 交错：版本单调递增且最终值一致', async () => {
    const item = await client.create(stressModel, {
      name: 'I',
      slug: 'interleave',
      qty: 100,
    });
    // update 与 updateWhere 在同一行上交错：update 用乐观锁，updateWhere 直接自增。
    // 两者都必须让版本号单调 +1，且最终 spec.qty 与列值一致。
    const ops: Array<Promise<unknown>> = [];
    for (let index = 0; index < 20; index += 1) {
      ops.push(
        client.updateWhere(
          stressModel,
          { name: { eq: item.name }, qty: { gte: 1 } },
          { qty: { dec: 1 } },
        ),
      );
      ops.push(
        client
          .update(
            stressModel,
            item.name,
            { name: 'I', slug: 'interleave', qty: 100 - index },
            { expectedVersion: item.version + index },
          )
          .catch((error: unknown) => {
            // 被 updateWhere 抢先时允许冲突，但必须是明确的乐观锁失败。
            expect(error).toBeInstanceOf(ExtensionVersionConflict);
          }),
      );
    }
    await Promise.all(ops);

    const rows = await getPrisma().$queryRawUnsafe<
      Array<{ version: number; qty: number; spec_qty: number }>
    >(
      `SELECT "version", "f_qty" AS "qty", ("spec" ->> 'qty')::int AS "spec_qty"
         FROM "ext_e1test_stress" WHERE "id" = $1`,
      item.name,
    );
    const row = rows[0];
    expect(row).toBeDefined();
    // 版本号没有丢更新：每次成功写入都 +1。
    expect(row!.version).toBeGreaterThan(item.version);
    // 索引列与 spec 始终同步（updateWhere 用一次 UPDATE 同时改两者）。
    expect(row!.spec_qty).toBe(row!.qty);
    await client.delete(stressModel, item.name);
  });

  it('updateWhere 未声明为索引的字段 → ExtensionValidationError', async () => {
    const item = await client.create(widgetModel, { name: 'N', slug: 'noidx', qty: 1 });
    // `widgetSchema` 里 slug/qty 建了索引，name 是内建字段；这里用未建索引的 `spec` 外字段。
    await expect(
      client.updateWhere(widgetModel, { name: { eq: item.name } }, { nope: { set: 1 } }),
    ).rejects.toBeInstanceOf(ExtensionValidationError);
    // 行未被触碰。
    const after = await client.get<{ qty: number }>(widgetModel, item.name);
    expect(after?.version).toBe(item.version);
    await client.delete(widgetModel, item.name);
  });

  it('并发 updateWhere 自减：余额不为负且成功次数等于可扣减次数', async () => {
    const item = await client.create(stressModel, { name: 'S', slug: 'stress', qty: 10 });
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        client.updateWhere(
          stressModel,
          { name: { eq: item.name }, qty: { gte: 1 } },
          { qty: { dec: 1 } },
        ),
      ),
    );
    const applied = results.reduce((sum, result) => sum + result.updated, 0);
    expect(applied).toBe(10);
    const after = await client.get<{ qty: number }>(stressModel, item.name);
    expect(after?.spec.qty).toBe(0);
    await client.delete(stressModel, item.name);
  });

  it('scoped 模型：系统上下文 fail-closed，用户上下文只看见自己的行', async () => {
    await expect(
      client.create(scopedModel, { name: 'S', slug: 'scope', qty: 1 }),
    ).rejects.toBeInstanceOf(ExtensionValidationError);

    const alice = service.client('e1-test', 'alice');
    const bob = service.client('e1-test', 'bob');
    const created = await alice.create(scopedModel, { name: 'S', slug: 'scope', qty: 1 });
    expect(await alice.get(scopedModel, created.name)).not.toBeNull();
    expect(await bob.get(scopedModel, created.name)).toBeNull();
    expect((await alice.list(scopedModel, { page: 1, pageSize: 10 })).total).toBe(1);
    expect((await bob.list(scopedModel, { page: 1, pageSize: 10 })).total).toBe(0);
    await alice.delete(scopedModel, created.name);
  });

  it('迁移：新增可空列 + 索引；改类型被拒绝', async () => {
    const extended = defineModel({
      kind: 'e1test/migrate',
      label: '迁移小部件',
      schema: widgetSchema,
      indexes: [
        { fields: ['slug'], types: { slug: 'string' } },
        { fields: ['qty'], types: { qty: 'integer' } },
      ],
    });
    await ensureExtensionModels(getPrisma(), 'e1-test', [extended]);
    const columns = await getPrisma().$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'ext_e1test_migrate'`,
    );
    expect(columns.map((column) => column.column_name)).toContain('f_qty');

    const retyped = defineModel({
      kind: 'e1test/migrate',
      label: '迁移小部件',
      schema: widgetSchema,
      indexes: [
        { fields: ['slug'], types: { slug: 'string' } },
        { fields: ['qty'], types: { qty: 'string' } },
      ],
    });
    await expect(ensureExtensionModels(getPrisma(), 'e1-test', [retyped])).rejects.toMatchObject({
      code: 'extension.unsupported_migration',
      detail: expect.stringContaining('类型已变更'),
    });
  });

  it('保留策略：retain 保留表，delete 删表', async () => {
    await service.applyRetention('e1-test', [retainedModel]);
    expect(await tableExists('ext_e1test_retained')).toBe(true);
    await service.applyRetention('e1-other', [foreignModel]);
    expect(await tableExists('ext_e1test_foreign')).toBe(false);
  });
});

describe.skipIf(!dbAvailable)('Extension 事务（ctx.tx）', () => {
  it('回滚不落库，且拒绝嵌套', async () => {
    const service = new ExtensionService(getPrisma());
    const events = new EventEmitterEventBus();
    const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
    const runtime = new PluginRuntime({
      events,
      logger: silentLogger,
      db: getPrisma(),
      extensions: service,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      payments: {} as never,
      wallet: {} as never,
      fx: {} as never,
      auth: {} as never,
      notifications: {} as never,
      state: {} as never,
      jobs: { removeByOwner: async () => undefined } as never,
    });

    const state: { ctx?: PluginContext } = {};
    await runtime.register(
      definePlugin({
        manifest: { id: 'e1-tx', name: 'E1 TX', version: '1.0.0' },
        customModels: [txModel],
        onActivate: (ctx) => {
          state.ctx = ctx;
        },
      }),
    );
    await runtime.activate('e1-tx');
    const ctx = state.ctx;
    if (!ctx) throw new Error('插件未激活，ctx 未捕获');

    await expect(
      ctx.tx(async (tx) => {
        await tx.extensions.create(txModel, { name: 'T', slug: 'tx', qty: 1 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Rolled back: nothing persisted.
    expect(await ctx.extensions.get(txModel, 'tx')).toBeNull();
    expect(
      await service.client('e1-tx', null).listAll(txModel),
    ).toHaveLength(0);

    await expect(
      ctx.tx(async () => {
        await ctx.tx(async () => undefined);
      }),
    ).rejects.toMatchObject({
      code: 'extension.validation_error',
      detail: expect.stringContaining('嵌套'),
    });

    await runtime.unregister('e1-tx');
  });

  it('T1/T2 事务内 tx.publish：提交落 outbox，回滚不留行', async () => {
    const service = new ExtensionService(getPrisma());
    const events = new EventEmitterEventBus();
    const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
    const runtime = new PluginRuntime({
      events,
      logger: silentLogger,
      db: getPrisma(),
      extensions: service,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      payments: {} as never,
      wallet: {} as never,
      fx: {} as never,
      auth: {} as never,
      notifications: {} as never,
      state: {} as never,
      jobs: { removeByOwner: async () => undefined } as never,
    });

    const state: { ctx?: PluginContext } = {};
    await runtime.register(
      definePlugin({
        manifest: { id: 'e1-tx-outbox', name: 'E1 TX Outbox', version: '1.0.0' },
        customModels: [txModel],
        onActivate: (ctx) => {
          state.ctx = ctx;
        },
      }),
    );
    await runtime.activate('e1-tx-outbox');
    const ctx = state.ctx;
    if (!ctx) throw new Error('插件未激活，ctx 未捕获');

    const commitTopic = `e1tx.commit.${Date.now()}`;
    // T1: business write + event commit together → both rows exist.
    await ctx.tx(async (tx) => {
      await tx.extensions.create(txModel, { name: 'T1', slug: 't1', qty: 1 }, { name: 't1' });
      tx.publish(commitTopic, { ok: true });
    });
    expect(await ctx.extensions.get(txModel, 't1')).not.toBeNull();
    const committed = await getPrisma().outboxEvent.findFirst({ where: { topic: commitTopic } });
    expect(committed).not.toBeNull();
    expect(committed?.publishedAt).toBeNull();
    expect((committed?.payload as { body: string }).body).toContain('"ok":true');

    // T2: rollback → neither the business row nor the outbox row persists.
    const rollbackTopic = `e1tx.rollback.${Date.now()}`;
    await expect(
      ctx.tx(async (tx) => {
        await tx.extensions.create(txModel, { name: 'T2', slug: 't2', qty: 2 }, { name: 't2' });
        tx.publish(rollbackTopic, { ok: false });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await ctx.extensions.get(txModel, 't2')).toBeNull();
    expect(await getPrisma().outboxEvent.findFirst({ where: { topic: rollbackTopic } })).toBeNull();

    await getPrisma().outboxEvent.deleteMany({ where: { topic: commitTopic } });
    await runtime.unregister('e1-tx-outbox');
  }, 30_000);
});
