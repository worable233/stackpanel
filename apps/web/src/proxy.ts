import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'sp_session';
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';

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
 * Build the per-request Content-Security-Policy (SECURITY-AUDIT-2026-10-04 L-2).
 *
 * Inline scripts are allowed only via a fresh per-request nonce plus
 * `'strict-dynamic'` — the `script-src 'unsafe-inline'` fallback is gone. Next.js
 * reads the nonce back out of the request `Content-Security-Policy` header and
 * applies it to its own scripts and inline bootstrap data automatically, so no
 * tag needs a manual nonce. Inline *styles* keep `'unsafe-inline'` because React
 * and UI libraries legitimately emit `style` attributes, which nonces cannot
 * cover without `'unsafe-hashes'` on every attribute.
 */
function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    `img-src 'self' data: blob:${API_ORIGIN ? ` ${API_ORIGIN}` : ''}`,
    "font-src 'self' data:",
    `style-src 'self' 'unsafe-inline'${API_ORIGIN ? ` ${API_ORIGIN}` : ''}`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `connect-src 'self'${API_ORIGIN ? ` ${API_ORIGIN}` : ''}${isDev ? ' ws: wss:' : ''}`,
  ].join('; ');
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
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const { pathname } = request.nextUrl;

  // Non-admin routes: skip the kernel round-trip, just carry the nonce.
  if (!pathname.startsWith('/admin')) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('Content-Security-Policy', csp);
    return response;
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
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
      return NextResponse.redirect(new URL('/login', request.url));
    }
    if (user.role !== 'ADMIN') {
      return new NextResponse('Forbidden', { status: 403 });
    }
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('Content-Security-Policy', csp);
    return response;
  } catch {
    return NextResponse.redirect(new URL('/login', request.url));
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
