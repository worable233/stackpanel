import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Button as WebButton } from '@/components/ui/button';
// Import the source, not the built `dist`: `@stackpanel/ui` is resolved through
// its package `exports`, so a stale build would silently keep testing old code.
import { Button as SharedButton } from '../../../packages/ui/src/button.js';

/**
 * Regression for the Base UI dev error:
 *
 *   "A component that acts as a button expected a native <button> because the
 *    `nativeButton` prop is true."
 *
 * `Button` wraps `@base-ui/react/button`, whose `nativeButton` defaults to
 * `true`. The documented link pattern (`<Button render={<Link href="…" />} />`)
 * therefore rendered an `<a>` that Base UI still treated as a native button: no
 * `role`, no keyboard handling, and a console error in development.
 *
 * Both copies of the wrapper must derive `nativeButton` from the element handed
 * to `render`. They are vendored separately (shadcn convention: `apps/web` keeps
 * its own, `packages/ui` serves plugin/theme frontends), so a fix that lands in
 * one copy and not the other is exactly how this regressed. The parity cases
 * below fail if either copy drifts again.
 */

/** Stands in for `next/link`: a component that ends up as an anchor. */
function FakeLink({ href, children, ...props }: ComponentProps<'a'>) {
  return createElement('a', { href, ...props }, children);
}

const cases = [
  {
    name: 'plain button stays a native <button>',
    props: {},
    expectedTag: 'button',
    expectNative: true,
  },
  {
    name: 'render={<a href>} drops native button semantics',
    props: { render: createElement('a', { href: '/shop' }) },
    expectedTag: 'a',
    expectNative: false,
  },
  {
    name: 'render={<Link href>} (component with href) drops them too',
    props: { render: createElement(FakeLink, { href: '/shop' }) },
    expectedTag: 'a',
    expectNative: false,
  },
  {
    name: 'render={<div />} is inferred as non-native from the tag name',
    props: { render: createElement('div') },
    expectedTag: 'div',
    expectNative: false,
  },
  {
    name: 'explicit nativeButton={false} on a non-button element',
    props: { render: createElement('div'), nativeButton: false },
    expectedTag: 'div',
    expectNative: false,
  },
  {
    name: 'an explicit nativeButton={true} overrides the link inference',
    props: { render: createElement(FakeLink, { href: '/shop' }), nativeButton: true },
    expectedTag: 'a',
    expectNative: true,
  },
] as const;

describe.each([
  ['apps/web/src/components/ui/button', WebButton],
  ['packages/ui/src/button', SharedButton],
])('%s derives nativeButton from `render`', (_name, Button) => {
  it.each(cases)('$name', ({ props, expectedTag, expectNative }) => {
    const html = renderToStaticMarkup(
      createElement(Button as typeof WebButton, props as ComponentProps<typeof WebButton>, 'Go'),
    );
    expect(/^<([a-z]+)/.exec(html)?.[1]).toBe(expectedTag);

    // Base UI's native path emits `type="button"` and no role; the non-native
    // path emits `role="button"` instead. Asserting on the emitted markup keeps
    // this honest without mounting a DOM.
    if (expectNative) {
      expect(html).toContain('type="button"');
      expect(html).not.toContain('role="button"');
    } else {
      expect(html).toContain('role="button"');
      expect(html).not.toContain('type="button"');
    }
  });
});
