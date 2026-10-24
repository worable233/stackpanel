import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: vi.fn(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value;
      },
    ];
  },
}));
vi.mock('@stackpanel/ui', () => ({
  Button: 'button',
  Select: 'select',
  Field: 'div',
  FieldGroup: 'div',
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({ default: 'a' }));
import { CartCheckout, type CartCheckoutProps } from '@/components/cart-checkout';

/**
 * Props this suite actually inspects.
 *
 * Listed explicitly instead of `Record<string, any>`: a typo in an assertion
 * (`node.props.onClik`) must fail the typecheck rather than silently read
 * `undefined` and make the test pass for the wrong reason.
 */
interface ElementProps {
  children?: unknown;
  name?: string;
  value?: unknown;
  type?: string;
  role?: string;
  action?: (data: FormData) => unknown;
  onClick?: () => void;
  onChange?: (event: unknown) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
  disabled?: boolean;
}

function nodes(value: unknown): ReactElement<ElementProps>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as ReactElement<ElementProps>;
  return [element, ...nodes(element.props.children)];
}
function setup() {
  const wallet = vi.fn().mockResolvedValue(undefined);
  const external = vi.fn().mockResolvedValue(undefined);
  const props: CartCheckoutProps = {
    lines: [{ id: 'one', name: 'Cloud', quantity: 1, total: 137 }],
    currency: 'CNY',
    methods: [
      { id: 'wallet', label: 'Wallet' },
      { id: 'epay:alipay', label: 'Alipay', providerId: 'epay', paymentMethod: 'alipay' },
    ],
    wallet,
    external,
    labels: {
      items: 'Items',
      total: 'Total',
      payment: 'Payment',
      submit: 'Pay',
      unavailable: 'Unavailable',
    },
  };
  const render = () => {
    hooks.cursor = 0;
    return nodes(CartCheckout(props));
  };
  const payment = () => {
    render()
      .find((node) => node.type === 'button' && node.props.onClick)!
      .props.onClick!();
    return render();
  };
  return { props, wallet, external, render, payment };
}
afterEach(() => {
  hooks.values.length = 0;
  hooks.cursor = 0;
});

describe('checkout directly from cart', () => {
  it('uses wallet checkout for selected cart IDs without a confirmation route', async () => {
    const ui = setup();
    const tree = ui.payment();
    expect(tree.find((node) => node.props.name === 'cartItemIds')?.props.value).toBe('one');
    expect(tree.find((node) => node.props.name === 'providerId')).toBeUndefined();
    const data = new FormData();
    data.append('cartItemIds', 'one');
    await tree.find((node) => node.type === 'form')!.props.action!(data);
    expect(ui.wallet).toHaveBeenCalledWith(data);
    expect(ui.external).not.toHaveBeenCalled();
  });
  it('switches external provider and method together with the payment action', async () => {
    const ui = setup();
    ui.payment()
      .find((node) => node.type === 'select')!
      .props.onChange!({ target: { value: 'epay:alipay' } });
    const tree = ui.render();
    expect(tree.find((node) => node.props.name === 'providerId')?.props.value).toBe('epay');
    expect(tree.find((node) => node.props.name === 'paymentMethod')?.props.value).toBe('alipay');
    await tree.find((node) => node.type === 'form')!.props.action!(new FormData());
    expect(ui.external).toHaveBeenCalledOnce();
    expect(ui.wallet).not.toHaveBeenCalled();
  });
  it('prevents checkout when selection is empty', () => {
    const ui = setup();
    ui.render()
      .find((node) => node.props.type === 'checkbox')!
      .props.onChange!({ target: { checked: false } });
    const tree = ui.render();
    expect(tree.find((node) => node.type === 'button')?.props.disabled).toBe(true);
    expect(tree.some((node) => node.type === 'form')).toBe(false);
  });
  it('releases the pending lock and shows an inline error after a failed payment action', async () => {
    const ui = setup();
    ui.wallet.mockRejectedValue(new Error('rejected'));
    ui.payment()
      .find((node) => node.type === 'form')!
      .props.onSubmit!({ preventDefault: vi.fn() });
    let tree = ui.render();
    expect(tree.find((node) => node.type === 'button')?.props.disabled).toBe(true);
    // Failures stay on the payment step with a localised notice; the raw error is not rethrown.
    await tree.find((node) => node.type === 'form')!.props.action!(new FormData());
    tree = ui.render();
    expect(tree.find((node) => node.type === 'button')?.props.disabled).toBe(false);
    expect(tree.some((node) => node.props.role === 'alert')).toBe(true);
  });
  it('starts at review and returns there from payment without submitting an order', () => {
    const ui = setup();
    expect(ui.render().some((node) => node.type === 'select')).toBe(false);
    const payment = ui.payment();
    payment.find((node) => node.type === 'button' && node.props.onClick)!.props.onClick!();
    expect(ui.render().some((node) => node.props.type === 'checkbox')).toBe(true);
    expect(ui.wallet).not.toHaveBeenCalled();
  });
  it.each(['PENDING', 'CANCELLED', 'REFUNDED', 'FAILED'])(
    'never marks %s as purchase success',
    (status) => {
      const ui = setup();
      ui.props.resultRequested = true;
      ui.props.result = { id: 'order', status, total: 137, currency: 'CNY' };
      const tree = ui.render();
      expect(tree.some((node) => node.type === 'h2' && node.props.children === '购买成功')).toBe(
        false,
      );
      expect(tree.some((node) => node.type === 'form')).toBe(false);
    },
  );
  it('shows the completion step only for a verified PAID order', () => {
    const ui = setup();
    ui.props.resultRequested = true;
    ui.props.result = { id: 'order', status: 'PAID', total: 137, currency: 'CNY' };
    expect(
      ui.render().some((node) => node.type === 'h2' && node.props.children === '购买成功'),
    ).toBe(true);
  });
  it('shows a verification error rather than success for a missing order', () => {
    const ui = setup();
    ui.props.resultRequested = true;
    ui.props.result = null;
    expect(
      ui.render().some((node) => node.type === 'h2' && node.props.children === '暂时无法核实订单'),
    ).toBe(true);
  });
});
