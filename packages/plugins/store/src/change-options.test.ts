import { describe, expect, it, vi } from 'vitest';
import type { CheckoutSelection, FulfillmentProvider, ServiceChangeOption } from '@stackpanel/sdk';
import { StoreError } from './errors';

vi.mock('./context', () => ({
  context: () => ({}),
  logger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  runTransaction: async (fn: () => Promise<unknown>) => fn(),
}));

const { assertChangeableSelection } = await import('./changes');

/** 一台「只能改快照数量 / IP 数量」的机器（对齐真实 zjmf 财务版）。 */
const OPTIONS: ServiceChangeOption[] = [
  {
    key: '3395984',
    label: '快照数量',
    current: '15711334',
    currentLabel: '1个',
    choices: [
      { value: '15711333', label: '0个' },
      { value: '15711334', label: '1个' },
      { value: '15711335', label: '2个' },
    ],
  },
  {
    key: '3395985',
    label: 'IP数量',
    current: '15711336',
    currentLabel: '2个IP',
    choices: [
      { value: '15711336', label: '2个IP' },
      { value: '15711337', label: '3个IP' },
    ],
  },
];

const service = {
  id: 'svc-1',
  runtime: {
    config: {
      cycle: 'monthly',
      selections: { '3395984': '15711334', '3395985': '15711336', '3395987': '15711340' },
    },
  },
} as Parameters<typeof assertChangeableSelection>[1];

function providerWith(options: ServiceChangeOption[] | undefined, throwOnProbe = false) {
  return {
    id: 'zjmf-upstream',
    listChangeOptions: async () => {
      if (throwOnProbe) throw new Error('upstream timeout');
      return options;
    },
  } as unknown as FulfillmentProvider;
}

function selection(selections: Record<string, string>): CheckoutSelection {
  return { cycle: 'monthly', selections };
}

describe('变配白名单：只允许上游真的受理的配置项', () => {
  it('白名单内的变更放行（快照数量 1个 → 2个）', async () => {
    await expect(
      assertChangeableSelection(providerWith(OPTIONS), service, selection({ '3395984': '15711335' })),
    ).resolves.toBeUndefined();
  });

  it('商品里有但上游未列的项（CPU）在报价阶段就被拦住，并说明可改项', async () => {
    const error = await assertChangeableSelection(
      providerWith(OPTIONS),
      service,
      selection({ '3395987': '15711341' }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).status).toBe(400);
    expect((error as StoreError).message).toContain('该服务不支持变更这些配置项：3395987');
    expect((error as StoreError).message).toContain('仅支持：快照数量、IP数量');
    expect((error as StoreError).code).toBe('store.change.option_unsupported');
  });

  it('档位不在上游 sub[] 里同样拦住（不能只信 key）', async () => {
    const error = await assertChangeableSelection(
      providerWith(OPTIONS),
      service,
      selection({ '3395985': '9999999' }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).message).toContain('IP数量');
  });

  it('值没有变化时不探测、不拦截', async () => {
    const probe = vi.fn();
    const provider = { id: 'p', listChangeOptions: probe } as unknown as FulfillmentProvider;
    await expect(
      assertChangeableSelection(provider, service, selection({ '3395984': '15711334' })),
    ).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('提供方不支持探测（undefined）时维持旧行为', async () => {
    await expect(
      assertChangeableSelection(providerWith(undefined), service, selection({ '3395987': '15711341' })),
    ).resolves.toBeUndefined();
  });

  it('探测失败不阻断变更（探测抖动不该让功能整体不可用）', async () => {
    await expect(
      assertChangeableSelection(providerWith(OPTIONS, true), service, selection({ '3395987': '15711341' })),
    ).resolves.toBeUndefined();
  });
});

describe('被拒项要说人话', () => {
  it('用商品配置里的 label 报错，而不是上游 oid', async () => {
    const product = {
      metadata: {
        checkoutConfig: {
          cycles: [{ id: 'monthly', price: 7653, months: 1 }],
          options: [
            { id: '3395987', type: 'select', label: '网络类型', choices: [] },
            { id: '3395984', type: 'select', label: '快照数量', choices: [] },
          ],
        },
      },
    };
    const error = await assertChangeableSelection(
      providerWith(OPTIONS),
      service,
      selection({ '3395987': '15711341' }),
      product as Parameters<typeof assertChangeableSelection>[3],
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).message).toContain('网络类型');
    expect((error as StoreError).message).not.toContain('3395987');
  });
});
