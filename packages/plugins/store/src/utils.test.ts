import { describe, expect, it } from 'vitest';
import { productUpdateSchema, parseCheckoutSelection } from './utils';

describe('instance name', () => {
  it('preserves a trimmed display name without altering provider selections', () => {
    expect(
      parseCheckoutSelection({
        instanceName: '  生产库  ',
        cycle: 'monthly',
        selections: { os: 'provider-id' },
      }),
    ).toEqual({ instanceName: '生产库', cycle: 'monthly', selections: { os: 'provider-id' } });
  });
  it('rejects oversized names and control characters', () => {
    expect(() => parseCheckoutSelection({ instanceName: 'x'.repeat(65) })).toThrow();
    expect(() => parseCheckoutSelection({ instanceName: 'bad\nname' })).toThrow();
  });
});

/**
 * 回归：zod 的 `.partial()` 不会中和 `.default()`。若直接用 `productSchema.partial()`，
 * 任何局部 PATCH 都会把带默认值的字段（currency/stock/fulfillmentType）重置为默认，
 * 例如改个库存就把 `api_token` 商品打回 `instant`、把 USD 打回 CNY。
 */
describe('productUpdateSchema', () => {
  it('only keeps the fields explicitly provided', () => {
    const parsed = productUpdateSchema.parse({ stock: 9999 });
    expect(parsed).toEqual({ stock: 9999 });
    expect(parsed).not.toHaveProperty('currency');
    expect(parsed).not.toHaveProperty('fulfillmentType');
  });

  it('does not reset fulfillmentType on an unrelated update', () => {
    const parsed = productUpdateSchema.parse({ price: 123 });
    expect(parsed).not.toHaveProperty('fulfillmentType');
  });

  it('keeps explicitly provided values', () => {
    const parsed = productUpdateSchema.parse({
      stock: 5,
      currency: 'USD',
      fulfillmentType: 'api_token',
    });
    expect(parsed).toEqual({ stock: 5, currency: 'USD', fulfillmentType: 'api_token' });
  });

  it('rejects an empty update', () => {
    expect(() => productUpdateSchema.parse({})).toThrow();
  });
});
