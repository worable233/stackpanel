import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, replace: vi.fn() }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void)) => state.effects.push(effect),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: state.replace }), useSearchParams: () => new URLSearchParams() }));
import { AutoSubmitForm } from '@/components/frontend-absorbed-clients';

function mount() {
  const listeners = new Map<string, (event: unknown) => void>();
  const attributes = new Map<string, string>();
  class Form {
    action = 'http://localhost/account/store/cloud';
    entries = [['quantity', '1']];
    reportValidity = vi.fn(() => true);
    setAttribute(key: string, value: string) { attributes.set(key, value); }
    getAttribute(key: string) { return attributes.get(key) ?? null; }
    addEventListener(name: string, fn: (event: unknown) => void) { listeners.set(name, fn); }
    removeEventListener = vi.fn();
  }
  class Button {
    disabled = false;
    dataset = {};
    constructor(private override = true) {}
    hasAttribute(name: string) { return name === 'formaction' && this.override; }
  }
  class Input {}
  const form = new Form();
  const button = new Button();
  const status = { hidden: true };
  vi.stubGlobal('HTMLFormElement', Form);
  vi.stubGlobal('HTMLButtonElement', Button);
  vi.stubGlobal('HTMLInputElement', Input);
  vi.stubGlobal('FormData', class { constructor(target: Form) { return target.entries; } });
  vi.stubGlobal('document', {
    getElementById: () => form,
    querySelector: () => status,
    querySelectorAll: () => [button],
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  vi.stubGlobal('window', {
    location: { href: form.action, origin: 'http://localhost' },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  AutoSubmitForm({ formId: 'product-selection' });
  const cleanup = state.effects.pop()!();
  return { form, button, status, cleanup, submit(submitter: unknown) {
    const event = { submitter, preventDefault: vi.fn() };
    listeners.get('submit')!(event);
    return event;
  } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); state.effects.length = 0; });

describe('quote form submit routing', () => {
  it('allows the purchase formaction when configuration matches the current quote', () => {
    const ui = mount();
    expect(ui.submit(ui.button).preventDefault).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();
    expect(ui.status.hidden).toBe(true);
    ui.cleanup?.();
  });
  it('blocks purchasing changed configuration and requests a fresh quote', () => {
    const ui = mount();
    ui.form.entries = [['quantity', '2']];
    expect(ui.submit(ui.button).preventDefault).toHaveBeenCalledOnce();
    expect(state.replace).toHaveBeenCalledWith('/account/store/cloud?quantity=2', { scroll: false });
    expect(ui.button.disabled).toBe(true);
    ui.cleanup?.();
  });
  it('does not permit purchase while a quote is pending', () => {
    const ui = mount();
    ui.form.setAttribute('aria-busy', 'true');
    expect(ui.submit(ui.button).preventDefault).toHaveBeenCalledOnce();
    expect(ui.button.disabled).toBe(true);
    ui.cleanup?.();
  });
  it('keeps ordinary form submissions on the soft quote navigation', () => {
    const ui = mount();
    expect(ui.submit(null).preventDefault).toHaveBeenCalledOnce();
    expect(state.replace).toHaveBeenCalledWith('/account/store/cloud?quantity=1', { scroll: false });
    ui.cleanup?.();
  });
  it('does not leave invalid configuration stuck in a pending state', () => {
    const ui = mount();
    ui.form.reportValidity.mockReturnValue(false);
    expect(ui.submit(null).preventDefault).toHaveBeenCalledOnce();
    expect(state.replace).not.toHaveBeenCalled();
    expect(ui.status.hidden).toBe(true);
    ui.cleanup?.();
  });
});
