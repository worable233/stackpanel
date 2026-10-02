import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { getApiClient } from '@/lib/api';

export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'sp_oauth_state';
const VERIFIER_COOKIE = 'sp_oauth_verifier';
const NONCE_COOKIE = 'sp_oauth_nonce';
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'sp_session';

function clearFlowCookies(response: NextResponse): void {
  response.cookies.delete({ name: STATE_COOKIE, path: '/auth/oauth' });
  response.cookies.delete({ name: VERIFIER_COOKIE, path: '/auth/oauth' });
  response.cookies.delete({ name: NONCE_COOKIE, path: '/auth/oauth' });
}

/**
 * BFF OAuth callback: verify the CSRF state cookie, exchange the code with the
 * kernel (which issues the session token), set the session cookie on the web
 * origin, then redirect to the user's home.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await ctx.params;
  const fallback = new URL('/login', request.url);
  const store = await cookies();
  const expectedState = store.get(STATE_COOKIE)?.value;
  const codeVerifier = store.get(VERIFIER_COOKIE)?.value;
  const nonce = store.get(NONCE_COOKIE)?.value;
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');

  try {
    if (!code || !state || !expectedState || !codeVerifier || !nonce || state !== expectedState) {
      throw new Error('OAuth state mismatch');
    }
    const result = await getApiClient().completeOAuthLogin(providerId, code, state, {
      codeVerifier,
      nonce,
    });
    const destination = result.user.role === 'ADMIN' ? '/admin' : '/account';
    const response = NextResponse.redirect(new URL(destination, request.url));
    response.cookies.set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 43200),
    });
    clearFlowCookies(response);
    return response;
  } catch {
    fallback.searchParams.set('error', 'oauth');
    const response = NextResponse.redirect(fallback);
    clearFlowCookies(response);
    return response;
  }
}
