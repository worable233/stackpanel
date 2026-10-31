import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { AFFILIATE_COOKIE, normalizeAffiliateCode } from './lib/affiliate';
import { readCaptchaCspSources, type CaptchaCspSources } from './lib/captcha-csp';

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'sp_session';
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';

/**
 * Referral attribution cookie. A visitor arriving on `?affid=<code>` keeps the
 * code so a later signup can be attributed to it. The Web layer only stores and
 * forwards the code — it never validates or redeems it; the owning plugin
 * decides whether the code is real.
 */
const AFFILIATE_COOKIE_MAX_AGE = Number(process.env.AFFILIATE_COOKIE_DAYS ?? 30) * 86_400;

/** The API origin, allowed for cross-origin styles/images/connections. */
function apiStyleOrigin(): string {
  try {
    const url = new URL(API_BASE_URL);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

const API_ORIGIN = apiStyleOrigin();

/**
 * Build the per-request Content-Security-Policy (security audit L-2).
 *
 * Production: inline scripts are allowed only via a fresh per-request nonce plus
 * `'strict-dynamic'` — there is no `script-src 'unsafe-inline'` fallback. Next.js
 * reads the nonce back out of the request `Content-Security-Policy` header and
 * applies it to its own scripts and inline bootstrap data, so no tag needs a
 * manual nonce. Verified against a real `next build` + `next start`: every
 * emitted `<script src>` carries the nonce, so `'strict-dynamic'` does not
 * discard the client chunks.
 *
 * Development: a nonce-bearing `'strict-dynamic'` policy makes the SSR shell
 * completely inert. The dev renderer emits its Flight/bootstrap inline scripts
 * without the request nonce, and under `'strict-dynamic'` the nonce also
 * disables host allowlisting for same-origin `<script src>` chunks. The result
 * is HTML that renders but whose buttons, menus, search, notifications and
 * avatar do nothing, with no useful console error. Dev therefore allows the
 * dev server's own inline bootstrap and chunks explicitly. This is dev-only:
 * `isDev` is derived from `NODE_ENV === 'development'`, so a production build
 * always gets the nonce policy below. Regression coverage lives in
 * `tests/contract05-csp.test.ts`.
 *
 * Inline *styles* keep `'unsafe-inline'` in both modes because React and UI
 * libraries legitimately emit `style` attributes, which nonces cannot cover
 * without `'unsafe-hashes'` on every attribute.
 */
/** Exported for the contract-05 CSP regression test. */
export function buildCsp(
  nonce: string,
  isDev: boolean,
  captcha: Partial<CaptchaCspSources> = {},
): string {
  // Sources arrive from the kernel over HTTP, so a partially-shaped payload must
  // degrade to the pre-captcha policy instead of throwing inside the proxy.
  const sources: CaptchaCspSources = {
    script: captcha.script ?? [],
    style: captcha.style ?? [],
    frame: captcha.frame ?? [],
    connect: captcha.connect ?? [],
    worker: captcha.worker ?? [],
  };
  // A challenge widget's own script is loaded by a Next chunk, which carries the
  // per-request nonce, so `'strict-dynamic'` already trusts the injected
  // `<script src>` in production — no vendor host belongs in `script-src` there,
  // and adding one would only dilute the policy (host-sources are ignored once
  // `'strict-dynamic'` is present). Dev has no `'strict-dynamic'`, so the origin
  // must be named explicitly or the widget never loads.
  const scriptSrc = isDev
    ? // Dev-only: Next's own inline bootstrap is emitted without the nonce, and
      // `'strict-dynamic'` would additionally drop same-origin chunks.
      `script-src 'self' 'unsafe-inline' 'unsafe-eval'${hosts(sources.script)}`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    // Without an explicit `frame-src` the widget iframe falls back to
    // `default-src 'self'` and is blocked. Declaring it keeps the fallback for
    // every other frame while letting the provider name its own origins.
    `frame-src 'self'${hosts(sources.frame)}`,
    `img-src 'self' data: blob:${API_ORIGIN ? ` ${API_ORIGIN}` : ''}`,
    "font-src 'self' data:",
    // A widget may inject its own theme stylesheet; without the origin the control
    // renders unstyled (or invisible) while the challenge itself still works.
    `style-src 'self' 'unsafe-inline'${API_ORIGIN ? ` ${API_ORIGIN}` : ''}${hosts(sources.style)}`,
    // Proof-of-work widgets (`new Worker(URL.createObjectURL(blob))`) need a blob
    // worker. `blob:` is declared only when a provider actually asks for a worker
    // or script source, so a deployment with no captcha keeps its previous policy
    // exactly. Deduplicated because a provider may name `blob:` itself.
    ...(sources.worker.length > 0 || sources.script.length > 0
      ? [`worker-src ${['\'self\'', ...new Set(['blob:', ...sources.worker])].join(' ')}`]
      : []),
    scriptSrc,
    // The widget's script posts its solution back to the challenge origin.
    `connect-src 'self'${API_ORIGIN ? ` ${API_ORIGIN}` : ''}${isDev ? ' ws: wss:' : ''}${hosts(sources.connect)}`,
  ].join('; ');
}

/** Render origins as CSP host-source values, or nothing when the list is empty. */
function hosts(origins: readonly string[] | undefined): string {
  if (!origins || origins.length === 0) return '';
  return ` ${origins.join(' ')}`;
}

/**
 * Next.js 16 proxy (replaces the legacy `middleware` convention).
 *
 * Two responsibilities, in order:
 *  1. Generate a per-request CSP nonce and attach it to the request (so Next.js
 *     can inject it into its scripts) and the response.
 *  2. First-line admin gate for `/admin` — every Fastify endpoint re-checks
 *     permissions, this only avoids rendering the shell for anonymous callers.
 *
 * Sessions are server-side, so the gate asks the kernel `/auth/session` instead
 * of decoding a JWT: no/invalid session -> `/login`, non-admin -> 403.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  // Cached inside `readCaptchaCspSources`; empty when no provider is installed,
  // which makes the policy identical to the pre-captcha implementation.
  const captchaSources = await readCaptchaCspSources();
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development', captchaSources).replace(
    "frame-ancestors 'none'",
    request.nextUrl.pathname === '/preview' ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
  );

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('x-stackpanel-request-path', request.nextUrl.pathname + request.nextUrl.search);
  requestHeaders.set('Content-Security-Policy', csp);

  const { pathname } = request.nextUrl;

  // Capture `?affid=` on any landing page. First click wins: an existing
  // attribution cookie is never overwritten, so a second code cannot steal a
  // visitor who already arrived through someone else's link.
  const affid = normalizeAffiliateCode(request.nextUrl.searchParams.get('affid'));
  const shouldSetAffiliate = affid !== null && !request.cookies.get(AFFILIATE_COOKIE)?.value;

  const withAffiliate = <T extends NextResponse>(response: T): T => {
    response.headers.set('X-Frame-Options', pathname === '/preview' ? 'SAMEORIGIN' : 'DENY');
    if (shouldSetAffiliate && affid) {
      response.cookies.set(AFFILIATE_COOKIE, affid, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: AFFILIATE_COOKIE_MAX_AGE,
      });
    }
    return response;
  };

  // Non-admin routes: skip the kernel round-trip, just carry the nonce.
  if (!pathname.startsWith('/admin')) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('Content-Security-Policy', csp);
    return withAffiliate(response);
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return withAffiliate(NextResponse.redirect(new URL('/login', request.url)));
  }
  try {
    const res = await fetch(`${API_BASE_URL}/auth/session`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => null)) as {
      user?: { role?: string } | null;
    } | null;
    const user = body?.user ?? null;
    if (!user) {
      return withAffiliate(NextResponse.redirect(new URL('/login', request.url)));
    }
    if (user.role !== 'ADMIN') {
      return withAffiliate(new NextResponse('Forbidden', { status: 403 }));
    }
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('Content-Security-Policy', csp);
    return withAffiliate(response);
  } catch {
    return withAffiliate(NextResponse.redirect(new URL('/login', request.url)));
  }
}

export const config = {
  matcher: [
    /*
     * Run on every page route so the nonce reaches the renderer, but skip API
     * routes, Next static/image assets, and link prefetches (which do not need a
     * CSP and would otherwise waste a nonce).
     */
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
