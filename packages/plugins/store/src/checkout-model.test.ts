import { describe, expect, it } from 'vitest';
import type { CheckoutConfigSchema } from '@stackpanel/sdk';
import { validateCheckoutSelection } from '@stackpanel/sdk';
import { reconcileSelection } from '../frontend/src/checkout-model';

const schema: CheckoutConfigSchema = {
  cycles: [
    { id: 'month', label: 'Monthly', price: 7200 },
    { id: 'year', label: 'Yearly', price: 72000 },
  ],
  options: [
    {
      id: 'image',
      label: 'Image',
      type: 'select',
      required: true,
      choices: [
        { id: 'hk-debian', label: 'Debian', requires: { region: 'hk' } },
        { id: 'sg-ubuntu', label: 'Ubuntu', requires: { region: 'sg' } },
      ],
    },
    {
      id: 'region',
      label: 'Region',
      type: 'select',
      required: true,
      choices: [
        { id: 'hk', label: 'HK' },
        { id: 'sg', label: 'SG' },
      ],
    },
    {
      id: 'cpu',
      label: 'CPU',
      type: 'select',
      required: true,
      choices: [{ id: 'provider-four', label: '4 cores' }],
    },
    {
      id: 'vpc',
      label: 'VPC',
      type: 'select',
      visibleWhen: { field: 'region', equals: 'sg' },
      choices: [{ id: 'vpc-one', label: 'VPC 1' }],
    },
  ],
};
describe('purchase configuration reconciliation', () => {
  it('resolves dependencies even when the child precedes the parent', () => {
    const result = reconcileSelection(schema, {});
    expect(result).toEqual({
      cycle: 'month',
      selections: { region: 'hk', image: 'hk-debian', cpu: 'provider-four' },
    });
    expect(validateCheckoutSelection(schema, result)).toEqual([]);
  });
  it('replaces stale dependent choices, preserves provider IDs and fills newly visible options', () => {
    const result = reconcileSelection(schema, {
      cycle: 'year',
      selections: { region: 'sg', image: 'hk-debian', cpu: 'provider-four' },
    });
    expect(result.selections).toMatchObject({
      image: 'sg-ubuntu',
      cpu: 'provider-four',
      vpc: 'vpc-one',
    });
    expect(validateCheckoutSelection(schema, result)).toEqual([]);
  });
  it('removes hidden fields from the submitted configuration', () => {
    expect(
      reconcileSelection(schema, { selections: { region: 'hk', vpc: 'vpc-one' } }).selections,
    ).not.toHaveProperty('vpc');
  });
  it('does not turn an invalid numeric value into a purchasable value', () => {
    const numeric: CheckoutConfigSchema = {
      cycles: schema.cycles,
      options: [{ id: 'disk', label: 'Disk', type: 'quantity', min: 20, max: 100, required: true }],
    };
    const result = reconcileSelection(numeric, { cycle: 'month', selections: { disk: 500 } });
    expect(validateCheckoutSelection(numeric, result)).not.toEqual([]);
  });
});
