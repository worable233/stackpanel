import 'server-only';
import { cookies, headers } from 'next/headers';
import { sessionCookieName, sessionCookieOptions } from './session-cookie';

/**
 * Write / clear the session cookie from a Server Action or Route Handler.
 *
 * One implementation for every site that mints a session (`/login`, `/register`,
 * `/setup`, impersonation, OAuth callback) so the flags cannot drift apart —
 * they already had, six copies deep, and the copy that decided `Secure` from
 * `NODE_ENV` silently lost the flag on TLS deployments configured differently.
 */
export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  const forwardedProto = await forwardedProtoHeader();
  store.set(sessionCookieName(), token, sessionCookieOptions({ forwardedProto }));
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(sessionCookieName());
}

/** `x-forwarded-proto` as seen by this request (undefined when not proxied). */
export async function forwardedProtoHeader(): Promise<string | null> {
  try {
    const headerStore = await headers();
    return headerStore.get('x-forwarded-proto');
  } catch {
    // `headers()` throws in a non-request scope (e.g. a job). Fall back to the
    // other signals in `sessionCookieSecure` instead of failing the login.
    return null;
  }
}
