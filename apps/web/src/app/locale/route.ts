import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, normalizeLocale } from '@/i18n/config';
import { safeInternalPath } from '@/lib/safe-path';

/**
 * Cookie-based interface language switch for surfaces that cannot run client
 * code — notably runtime-loaded theme layouts, which are plain SSR ESM under
 * the RSC server layer (no `useState`, and CSP forbids inline scripts).
 *
 * The picker is a plain GET form, so this route only has to: persist the
 * choice, then send the browser back to where it came from. Both the target and
 * the return path are validated — a cross-origin `next` would be an open
 * redirect, and `//evil.com` renders as a protocol-relative URL in a form
 * action.
 */
const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const locale = normalizeLocale(searchParams.get('locale'));

  // Prefer the explicit `next` the form carried; fall back to the referrer's
  // path so a picker that forgets the hidden field still returns in place.
  const requestOrigin = request.headers.get('host')
    ? `${request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '')}://${request.headers.get('host')}`
    : new URL(request.url).origin;
  let target = safeInternalPath(searchParams.get('next'));
  if (!target) {
    const referer = request.headers.get('referer');
    if (referer) {
      try {
        const from = new URL(referer);
        if (from.origin === requestOrigin) {
          target = safeInternalPath(`${from.pathname}${from.search}`);
        }
      } catch {
        /* a malformed referer just means "no target" */
      }
    }
  }

  // Redirect against the **host the browser actually used**, not
  // `request.nextUrl.origin`: Next normalises the latter to the configured
  // `localhost` host, so a visitor on `127.0.0.1` (or a LAN IP / proxy) would be
  // bounced to a different origin — where the cookie we just set does not apply
  // and the language silently does not change.
  const requestUrl = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto') ?? requestUrl.protocol.replace(':', '');
  const origin = host ? `${proto}://${host}` : requestUrl.origin;
  const response = target
    ? NextResponse.redirect(new URL(target, origin), 303)
    : NextResponse.redirect(new URL('/', origin), 303);
  response.cookies.set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
  response.headers.set('cache-control', NO_STORE['cache-control']);
  return response;
}
