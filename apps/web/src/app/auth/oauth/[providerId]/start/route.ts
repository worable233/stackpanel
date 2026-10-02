import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { getApiClient } from '@/lib/api';

export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'sp_oauth_state';
const VERIFIER_COOKIE = 'sp_oauth_verifier';
const NONCE_COOKIE = 'sp_oauth_nonce';

/**
 * BFF start of the OAuth flow: generate a CSRF state, remember it in an
 * HttpOnly cookie scoped to the callback path, then redirect the browser to the
 * provider's authorization URL (resolved via the kernel /auth/oauth/:id/authorize).
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await ctx.params;
  const fallback = new URL('/login', request.url);
  try {
    const state = randomBytes(16).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const result = await getApiClient().getOAuthAuthorizeUrl(providerId, state, {
      codeChallenge,
      nonce,
    });
    const response = NextResponse.redirect(result.authorizeUrl);
    response.cookies.set(STATE_COOKIE, result.state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/auth/oauth',
      maxAge: 300,
    });
    response.cookies.set(VERIFIER_COOKIE, codeVerifier, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/auth/oauth',
      maxAge: 300,
    });
    response.cookies.set(NONCE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/auth/oauth',
      maxAge: 300,
    });
    return response;
  } catch {
    fallback.searchParams.set('error', 'oauth');
    return NextResponse.redirect(fallback);
  }
}
