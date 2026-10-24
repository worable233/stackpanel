import { describe, expect, it } from 'vitest';
import { deliveryModel } from './data';

/**
 * 扩展模型的物理列类型回归（真机部署时抓到的缺陷）。
 *
 * `nextAttemptAt` 存的是 epoch 毫秒（≈1.7e12），而 PostgreSQL `integer` 是 int4
 * （上限 2 147 483 647）。一旦把它声明成 `integer`，每次退避重试的写入都会
 * `22003: value "..." is out of range for type integer`，投递记录永远停在
 * PENDING，重试 3 次后被判死——webhook 全链路静默失效。
 *
 * 同款陷阱在 referral 的 `freezeUntil`、store 的 `expiresAtMs` 都已踩过并写明注释；
 * 这里用断言把 channel 也钉住，避免以后再被「看起来是整数」误导。
 */
describe('channel 扩展模型列类型', () => {
  it('nextAttemptAt 必须用 number（float8），不能是 integer（int4 装不下 epoch ms）', () => {
    const index = deliveryModel.indexes?.find((candidate) =>
      candidate.fields.includes('nextAttemptAt'),
    );
    expect(index).toBeDefined();
    expect(index?.types.nextAttemptAt).toBe('number');
  });
});
