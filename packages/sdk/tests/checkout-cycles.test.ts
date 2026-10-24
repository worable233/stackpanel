import { describe, expect, it } from 'vitest';
import type { CheckoutConfigSchema } from '../src/fulfillment.js';
import { computeCheckoutPrice } from '../src/fulfillment.js';

/**
 * 周期与首期费用（#8）。
 *
 * 审计指出文档把「周期能力」整体低估了。这里把被点名的三条能力逐条锁住：
 *
 * 1. **自定义整月周期**：`cycles[].months` 优先于 id 推断（id 推断在 store 的
 *    `utils.ts`，此处只验 SDK 的计价部分按 `cycle.id` 取档位价格）。
 * 2. **`recurring: false`**：首期计入 `price`、续费不计入 `renewPrice` ——
 *    这是「一次性附加费/初装费」的唯一表达方式。若这条退化，用户会被每次续费
 *    重复收一次初装费。
 * 3. **quantity 型选项同样遵守 `recurring`**：按量计费的一次性档位不能进入续费价。
 *
 * 这些是**公式级**不变量，不依赖上游 provider。
 */

const schema: CheckoutConfigSchema = {
  cycles: [
    { id: 'monthly', label: '月付', price: 5000, renewPrice: 5000 },
    { id: 'quarterly', label: '季付', price: 13500, months: 3 },
    { id: 'custom7', label: '7 个月', price: 30000, months: 7 },
  ],
  options: [
    {
      id: 'os',
      label: '操作系统',
      type: 'select',
      choices: [
        { id: 'linux', label: 'Linux' },
        { id: 'windows', label: 'Windows', price: 1000, recurring: true },
      ],
    },
    {
      id: 'setup',
      label: '初装服务',
      type: 'select',
      choices: [{ id: 'basic', label: '基础部署', price: 2000, recurring: false }],
    },
    {
      id: 'backup',
      label: '备份空间',
      type: 'quantity',
      unit: 'GB',
      choices: [{ id: 'gb', label: '每 GB', price: 100, recurring: false }],
    },
    {
      id: 'bandwidth',
      label: '带宽',
      type: 'quantity',
      unit: 'Mbps',
      choices: [{ id: 'mbps', label: '每 Mbps', price: 50 }],
    },
  ],
} as CheckoutConfigSchema;

describe('周期与首期费用口径（#8）', () => {
  it('按月付计价：price 与 renewPrice 都包含周期价', () => {
    const result = computeCheckoutPrice(schema, { cycle: 'monthly' });
    expect(result.price).toBe(5000);
    expect(result.renewPrice).toBe(5000);
  });

  it('自定义整月周期（months=7）按该周期的 price 计价', () => {
    const result = computeCheckoutPrice(schema, { cycle: 'custom7' });
    expect(result.price).toBe(30000);
    // 该周期未声明 renewPrice，回退到自身 price（不是每月 5000 × 7 的猜测）。
    expect(result.renewPrice).toBe(30000);
  });

  it('季付声明了独立 price，不被月价 ×3 覆盖', () => {
    const result = computeCheckoutPrice(schema, { cycle: 'quarterly' });
    expect(result.price).toBe(13500);
  });

  it('recurring: false 的选项只进首期价，不进续费价', () => {
    const result = computeCheckoutPrice(schema, {
      cycle: 'monthly',
      selections: { os: 'linux', setup: 'basic' },
    });
    // 首期：5000 + 2000 初装
    expect(result.price).toBe(7000);
    // 续费：只有周期价，初装费不再收
    expect(result.renewPrice).toBe(5000);
  });

  it('recurring: true 的选项同时进首期与续费', () => {
    const result = computeCheckoutPrice(schema, {
      cycle: 'monthly',
      selections: { os: 'windows' },
    });
    expect(result.price).toBe(6000);
    expect(result.renewPrice).toBe(6000);
  });

  it('按量计费的一次性档位不进续费价', () => {
    const result = computeCheckoutPrice(schema, {
      cycle: 'monthly',
      selections: { backup: 10 },
    });
    expect(result.price).toBe(5000 + 1000);
    expect(result.renewPrice).toBe(5000);
  });

  it('未声明 recurring 的档位默认进入续费（常态是按周期收）', () => {
    const result = computeCheckoutPrice(schema, {
      cycle: 'monthly',
      selections: { bandwidth: 100 },
    });
    expect(result.price).toBe(5000 + 5000);
    expect(result.renewPrice).toBe(5000 + 5000);
  });

  it('一次性与循环项混选时各自归位', () => {
    const result = computeCheckoutPrice(schema, {
      cycle: 'monthly',
      selections: { os: 'windows', setup: 'basic', backup: 5, bandwidth: 2 },
    });
    // 首期：5000 + 1000 + 2000 + 500 + 100
    expect(result.price).toBe(8600);
    // 续费：5000 + 1000 + 100
    expect(result.renewPrice).toBe(6100);
  });
});
