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

/**
 * Regression: a nonce + `'strict-dynamic'` policy in development leaves the SSR
 * shell completely inert.
 *
 * `next dev` emits its Flight/bootstrap inline scripts without the request nonce,
 * and `'strict-dynamic'` also disables host allowlisting for same-origin
 * `<script src>` chunks. The page renders but every button, menu, search box,
 * notification and avatar click does nothing, with no actionable console error.
 * Dev must therefore allow the dev renderer's own scripts; production must stay
 * nonce-based.
 */
describe('dev CSP keeps the SSR shell interactive', () => {
  it("dev allows the dev renderer's own inline bootstrap", () => {
    const scriptSrc = directives(buildCsp('prod-nonce', true)).get('script-src') ?? [];
    expect(scriptSrc).toContain("'unsafe-inline'");
  });

  it("dev does not use 'strict-dynamic' (which would drop same-origin chunks)", () => {
    const scriptSrc = directives(buildCsp('prod-nonce', true)).get('script-src') ?? [];
    expect(scriptSrc).not.toContain("'strict-dynamic'");
  });

  it('dev keeps same-origin chunks loadable via host allowlisting', () => {
    const scriptSrc = directives(buildCsp('prod-nonce', true)).get('script-src') ?? [];
    expect(scriptSrc).toContain("'self'");
  });

  it('dev keeps unsupported-eval allowed for the dev renderer', () => {
    const scriptSrc = directives(buildCsp('prod-nonce', true)).get('script-src') ?? [];
    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  it("production still uses the nonce and never 'unsafe-inline'", () => {
    // Guard the direction of the fix: relaxing dev must not relax production.
    const scriptSrc = directives(buildCsp('prod-nonce', false)).get('script-src') ?? [];
    expect(scriptSrc).toContain("'nonce-prod-nonce'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("dev CSS and production CSS both keep style-src 'self' 'unsafe-inline'", () => {
    for (const isDev of [true, false]) {
      const styleSrc = directives(buildCsp('n', isDev)).get('style-src') ?? [];
      expect(styleSrc).toContain("'self'");
      expect(styleSrc).toContain("'unsafe-inline'");
    }
  });
});

/**
 * Captcha widget CSP (spec §5.1).
 *
 * A human-verification widget is third-party browser code, so the page policy
 * has to name its iframe and XHR origins. Those origins come from the installed
 * provider — the kernel sanitizes them — never from the web layer, which is what
 * keeps vendor knowledge out of the host.
 */
describe('CSP allows a captcha widget without weakening script-src (spec §5.1)', () => {
  const EMPTY = { script: [], frame: [], connect: [] };

  it('is byte-identical to the pre-captcha policy when no provider is installed', () => {
    // `frame-src 'self'` is added explicitly and is exactly what the previous
    // `default-src 'self'` fallback already meant, so behaviour is unchanged.
    expect(buildCsp('n', false, EMPTY)).toBe(buildCsp('n', false));
    expect(buildCsp('n', true, EMPTY)).toBe(buildCsp('n', true));
  });

  it('adds the declared iframe and XHR origins to frame-src and connect-src', () => {
    const csp = buildCsp('n', false, {
      script: ['https://challenges.example.test'],
      style: ['https://challenges.example.test'],
      frame: ['https://challenges.example.test'],
      connect: ['https://challenges.example.test'],
      worker: ['https://challenges.example.test'],
    });
    const map = directives(csp);
    expect(map.get('frame-src')).toEqual(["'self'", 'https://challenges.example.test']);
    expect(map.get('connect-src')).toContain('https://challenges.example.test');
    // A proof-of-work widget injects its own stylesheet and spawns a blob worker;
    // without these two directives it renders unstyled and never solves, which on
    // `required` is indistinguishable from a broken login form.
    expect(map.get('style-src')).toContain('https://challenges.example.test');
    expect(map.get('worker-src')).toEqual(['\'self\'', 'blob:', 'https://challenges.example.test']);
  });

  it('never widens the production script-src', () => {
    const csp = buildCsp('n', false, {
      script: ['https://challenges.example.test'],
      frame: ['https://challenges.example.test'],
      connect: [],
    });
    const scriptSrc = directives(csp).get('script-src') ?? [];
    // `'strict-dynamic'` already trusts a script injected by a nonce-bearing
    // chunk, so naming the host would only dilute the policy.
    expect(scriptSrc).toEqual(["'self'", "'nonce-n'", "'strict-dynamic'"]);
    expect(csp).not.toContain("'unsafe-inline'; ");
  });

  it('names the host in dev, where strict-dynamic is absent', () => {
    const csp = buildCsp('n', true, {
      script: ['https://challenges.example.test'],
      frame: [],
      connect: [],
    });
    expect(directives(csp).get('script-src')).toContain('https://challenges.example.test');
  });
});
