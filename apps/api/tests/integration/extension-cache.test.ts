import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModel } from '@stackpanel/sdk';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { ExtensionService } from '../../src/extensions/service.ts';
import { DataCache } from '../../src/cache/data-cache.ts';
import { checkDbAvailable } from '../helpers.ts';

const dbAvailable = await checkDbAvailable();

const cachedSchema = z.object({ slug: z.string(), qty: z.number().int() });

// `qty` 是只增统计列（volatile）：写它不该打穿读缓存。
// `slug` 是真配置：写它必须让缓存失效。
const cachedModel = defineModel({
  kind: 'e1cache/widget',
  label: '缓存小部件',
  schema: cachedSchema,
  indexes: [
    { fields: ['slug'], types: { slug: 'string' }, unique: true },
    { fields: ['qty'], types: { qty: 'integer' } },
  ],
  cacheTtlMs: 60_000,
  volatileFields: ['qty'],
});

describe.skipIf(!dbAvailable)('Extension 读缓存（内核托管，ADR-0022 D3）', () => {
  const cache = new DataCache();
  const service = new ExtensionService(getPrisma(), cache);
  const client = service.client('e1-cache', null);

  beforeAll(async () => {
    await service.registerModels('e1-cache', [cachedModel]);
    for (const item of await client.listAll(cachedModel)) await client.delete(cachedModel, item.name);
  });

  afterAll(async () => {
    for (const item of await client.listAll(cachedModel)) await client.delete(cachedModel, item.name);
    await service.applyRetention('e1-cache', [cachedModel]);
  });

  it('serves reads from the cache and drops them on a meaningful write', async () => {
    await client.create(cachedModel, { slug: 'one', qty: 1 }, { name: 'w1' });
    // 第一次读回源并填充缓存。
    const readSpec = async (name: string) => {
      const instance = await client.get<Record<string, unknown>>(cachedModel, name);
      return instance?.spec as Record<string, unknown> | undefined;
    };
    expect(await readSpec('w1')).toMatchObject({ slug: 'one' });

    // 绕过 client 直接改库：如果读真的走缓存，这里应该读不到新值。
    await getPrisma().$executeRawUnsafe(
      `UPDATE ext_e1cache_widget SET "spec" = jsonb_set("spec", '{slug}', '"bypassed"') WHERE "id" = 'w1'`,
    );
    expect(await readSpec('w1')).toMatchObject({ slug: 'one' });

    // 通过 client 写一个「非 volatile」字段 → 缓存必须失效，读到新值。
    await client.updateWhere(cachedModel, { name: { eq: 'w1' } }, { slug: { set: 'visible' } });
    expect(await readSpec('w1')).toMatchObject({ slug: 'visible' });
  });

  it('keeps the cache warm when only volatile fields are written', async () => {
    await client.create(cachedModel, { slug: 'two', qty: 1 }, { name: 'w2' });
    expect((await client.get<Record<string, unknown>>(cachedModel, 'w2'))?.spec).toMatchObject({ qty: 1 });

    // 直接改库制造「缓存里的 qty 已过期」的状态。
    await getPrisma().$executeRawUnsafe(
      `UPDATE ext_e1cache_widget SET "spec" = jsonb_set("spec", '{qty}', '99') WHERE "id" = 'w2'`,
    );
    // 写 volatile 字段不失效：仍然命中缓存的 qty = 1。
    await client.updateWhere(cachedModel, { name: { eq: 'w2' } }, { qty: { set: 5 } });
    expect((await client.get<Record<string, unknown>>(cachedModel, 'w2'))?.spec).toMatchObject({ qty: 1 });
  });

  it('treats a whole-row update that only rewrites volatile fields as a no-op', async () => {
    await client.create(cachedModel, { slug: 'five', qty: 1 }, { name: 'w5' });
    expect((await client.get<Record<string, unknown>>(cachedModel, 'w5'))?.spec).toMatchObject({ qty: 1 });

    // 绕过 client 直接改库，制造「缓存里的 qty 已过期」。
    await getPrisma().$executeRawUnsafe(
      `UPDATE ext_e1cache_widget SET "spec" = jsonb_set("spec", '{qty}', '77') WHERE "id" = 'w5'`,
    );

    // update 是整行重写，但新旧 spec 只有 qty(q=77 → 1) 不同 → volatile，不失效。
    await client.update(cachedModel, 'w5', { slug: 'five', qty: 1 });
    // 再直接改库：若上面误失效了缓存，下面的读会看到 88。
    await getPrisma().$executeRawUnsafe(
      `UPDATE ext_e1cache_widget SET "spec" = jsonb_set("spec", '{qty}', '88') WHERE "id" = 'w5'`,
    );
    expect((await client.get<Record<string, unknown>>(cachedModel, 'w5'))?.spec).toMatchObject({ qty: 1 });

    // 真的改了配置字段 → 缓存失效。
    await client.update(cachedModel, 'w5', { slug: 'five-renamed', qty: 1 });
    expect((await client.get<Record<string, unknown>>(cachedModel, 'w5'))?.spec).toMatchObject({
      slug: 'five-renamed',
    });
    await client.delete(cachedModel, 'w5');
  });

  it('invalidates on create and delete', async () => {
    // 先建立缓存快照（此刻只有 w1、w2）。
    expect((await client.listAll(cachedModel)).length).toBe(2);
    await client.create(cachedModel, { slug: 'three', qty: 1 }, { name: 'w3' });
    // create 必须让 listAll 的缓存失效，否则这里仍是 2。
    expect((await client.listAll(cachedModel)).length).toBe(3);
    await client.delete(cachedModel, 'w3');
    expect((await client.listAll(cachedModel)).length).toBe(2);
  });

  it('invalidates on getMany and page reads too', async () => {
    expect((await client.getMany(cachedModel, ['w1', 'w2'])).size).toBe(2);
    await client.create(cachedModel, { slug: 'four', qty: 1 }, { name: 'w4' });
    const page = await client.page<Record<string, unknown>>(cachedModel, { limit: 10 });
    expect(page.items.map((item) => item.name).sort()).toEqual(['w1', 'w2', 'w4']);
    await client.delete(cachedModel, 'w4');
  });
});
