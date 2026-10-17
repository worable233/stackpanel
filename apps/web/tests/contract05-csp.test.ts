import { describe, expect, it } from 'vitest';
import { buildCsp } from '@/proxy';
import { buildFrontendStyleLinks } from '@/lib/frontend-style-links';

/**
 * Contract 05 §5 / §3.6 — a package stylesheet must actually be allowed by the
 * page's CSP.
 *
 * The link is emitted same-origin (through the web BFF), so `style-src 'self'`
 * must permit it. This is the regression that matters: if the packaged CSS were
 * ever emitted from the kernel origin (or inline), `'self'` would block it and
 * the page would silently fall back to host typography.
 */

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name!, values];
      }),
  );
}

function isSameOrigin(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

describe('CSP allows package stylesheets (contract 05 §5)', () => {
  it("emits style-src 'self' so a same-origin package <link> loads", () => {
    const csp = buildCsp('test-nonce', false);
    const styleSrc = directives(csp).get('style-src') ?? [];
    expect(styleSrc).toContain("'self'");

    const links = buildFrontendStyleLinks(
      {
        id: 'default',
        descriptor: {
          available: true,
          manifest: { styles: ['frontend/dist/theme.css'], entry: 'frontend/dist/index.js' },
          revision: 'abc123def456',
        },
      },
      [{ id: 'store', manifest: { styles: ['frontend/dist/store.css'] }, revision: 'f00dbabe1234' }],
    );
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      // Same-origin by construction: the BFF path, never the kernel origin.
      expect(isSameOrigin(link.href)).toBe(true);
      expect(link.href.startsWith('/api/plugins/')).toBe(true);
    }
  });

  it('never needs a per-link nonce or hash (styles are not inline)', () => {
    const csp = buildCsp('test-nonce', false);
    const styleSrc = directives(csp).get('style-src') ?? [];
    expect(styleSrc.some((value) => value.startsWith("'nonce-"))).toBe(false);
    expect(styleSrc.some((value) => value.startsWith("'sha256-"))).toBe(false);
  });

  it('keeps script-src nonce-based so the policy is not weakened', () => {
    const csp = buildCsp('nonce-123', false);
    const scriptSrc = directives(csp).get('script-src') ?? [];
    expect(scriptSrc).toContain("'nonce-nonce-123'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});
