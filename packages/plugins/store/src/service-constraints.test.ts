import { describe, expect, it } from 'vitest';
import { serviceInstanceModel } from './data.js';

/**
 * 「绑定上游服务」设计漏洞的约束。
 *
 * 现场（用户实测触发）：
 *   {"id":"bound-d8a0b240…","spec":{"productId":"33363", …}}
 * `33363` 是**上游**商品 id，却被当成本地商品 id 落库；`orderId: null`，
 * 没有商品、没有订单、没有凭证。后果：不能续费、不能退款、不能对账，却计入
 * ACTIVE 统计，用户点进去还要被判越权 404。
 *
 * 修复分两层：应用层拒绝无映射的绑定（operations.ts），数据层用唯一索引
 * 挡并发重复绑定（这里断言的是声明本身）。
 */

type IndexDecl = {
  fields: string[];
  unique?: boolean;
  where?: { kind: string };
};

function indexes(): IndexDecl[] {
  return (serviceInstanceModel.indexes ?? []) as unknown as IndexDecl[];
}

describe('service-instance uniqueness', () => {
  it('declares a unique index on the upstream service id', () => {
    const unique = indexes().filter((entry) => entry.unique === true);
    const provider = unique.find((entry) => entry.fields.includes('providerServiceId'));
    expect(provider).toBeDefined();
  });

  it('restricts that index to non-null values', () => {
    // `providerServiceId` 在普通购买的实例上是 NULL。PostgreSQL 认为多个 NULL
    // 互不相等，所以不加谓词的话：要么这条唯一索引约束不到重复绑定，要么（若
    // 有人误以为它约束了）让所有无上游编号的实例彼此冲突。
    const provider = indexes().find(
      (entry) => entry.unique === true && entry.fields.includes('providerServiceId'),
    );
    expect(provider?.where).toEqual({ kind: 'notNull' });
  });

  it('keeps the other lookups non-unique', () => {
    // 同一用户可以有多个实例、同一商品可以被多次购买 —— 这些不能是唯一索引。
    for (const field of ['userId', 'productId', 'orderId', 'state']) {
      const entry = indexes().find((candidate) => candidate.fields.includes(field));
      expect(entry?.unique ?? false, `${field} 不应是唯一索引`).toBe(false);
    }
  });
});

describe('service-instance schema carries what the design requires', () => {
  it('keeps productId as a required field', () => {
    // 实例必须属于某个本地商品；这个字段一旦可空，幽灵实例就有了生存空间。
    const schema = serviceInstanceModel.schema as unknown as {
      safeParse: (input: unknown) => { success: boolean };
    };
    const base = {
      userId: 'u1',
      productName: 'X',
      fulfillmentType: 'upstream_service',
      amount: 100,
    };
    expect(schema.safeParse({ ...base, productId: 'p1' }).success).toBe(true);
    expect(schema.safeParse(base).success).toBe(false);
  });

  it('allows orderId to be null but records it explicitly', () => {
    // 上游导入没有本站订单；可空是允许的，但必须显式写 null 而不是缺字段。
    const schema = serviceInstanceModel.schema as unknown as {
      safeParse: (input: unknown) => { success: boolean };
    };
    const row = {
      userId: 'u1',
      productId: 'p1',
      productName: 'X',
      fulfillmentType: 'upstream_service',
      amount: 100,
      orderId: null,
    };
    expect(schema.safeParse(row).success).toBe(true);
  });
});
