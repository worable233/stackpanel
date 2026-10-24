import { describe, expect, it, vi } from 'vitest';
import { FrontendRenderBoundary } from '@/components/frontend-render-boundary';
import { removeFailedStyleLink } from '@/components/frontend-style-links';

/**
 * Contract 06 §1.3 — independent degradation paths.
 *
 * Two distinct failures must stay isolated:
 *   1. A package that **renders** badly degrades to an inline notice (the host
 *      shell and other packages keep rendering).
 *   2. A package stylesheet that **fails to load** is removed from the DOM so no
 *      stale/partial rules linger.
 *
 * Both are unit-tested directly: the boundary's state machine without a DOM, and
 * the `<link>` removal against a minimal element stub.
 */

describe('render failure degradation (contract 06 §1.3)', () => {
  it('turns a thrown render error into a static failure state', () => {
    const state = FrontendRenderBoundary.getDerivedStateFromError();
    // The raw message is not part of the state: only a localised notice is rendered.
    expect(state).toEqual({ failed: true });
    expect(state).not.toHaveProperty('message');
  });

  it('reports the failure with the package label and never rethrows', () => {
    const boundary = new FrontendRenderBoundary({ children: null, label: 'plugins:store' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => boundary.componentDidCatch(new Error('boom'))).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain('plugins:store');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('stylesheet failure degradation (contract 06 §1.3)', () => {
  it('removes the failed <link> from the DOM', () => {
    const remove = vi.fn();
    removeFailedStyleLink({ remove });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not touch anything else (no throwing on a detached element)', () => {
    expect(() => removeFailedStyleLink({ remove: () => undefined })).not.toThrow();
  });
});
