'use client';

import { createElement } from 'react';
import type { FrontendStyleLink } from '@/lib/frontend-style-links';

/**
 * Contract 05 §3.6 + contract 06 §1.3 — render and *manage* the package
 * stylesheet `<link>`s.
 *
 * On load failure (404, MIME error, CSP block, timeout) the failed `<link>` is
 * removed from the DOM so a stale/partial stylesheet never lingers, and the page
 * falls back to the host's default typography (`globals.css`). CSS `<link>`s are
 * non-render-blocking, so a failure here must never blank the page or trigger an
 * error boundary.
 *
 * This is the client half of the single controlled injection point; the server
 * component (`frontend-stylesheets.tsx`) computes the deterministic link set via
 * `buildFrontendStyleLinks`.
 */
/**
 * Contract 06 §1.3 — drop a stylesheet `<link>` that failed to load.
 *
 * Exported separately from the component so the degradation contract is
 * directly testable (and so there is exactly one removal behaviour).
 */
export function removeFailedStyleLink(element: Pick<HTMLLinkElement, 'remove'>): void {
  element.remove();
}

export default function FrontendStyleLinks({ links }: { links: FrontendStyleLink[] }) {
  if (links.length === 0) return null;
  return (
    <>
      {links.map((link) =>
        createElement('link', {
          key: link.key,
          rel: 'stylesheet',
          href: link.href,
          'data-sp-style': link.marker,
          ...(link.revision ? { 'data-sp-revision': link.revision } : {}),
          // Contract 06 §1.3: drop the failed link so it cannot leave stale rules.
          onError: (event: { currentTarget: HTMLLinkElement }) => {
            removeFailedStyleLink(event.currentTarget);
          },
        }),
      )}
    </>
  );
}
