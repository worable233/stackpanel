/**
 * Session cookie contract, web side (ADR-0017 §4, security audit M-1).
 *
 * The web BFF writes the session cookie itself (the API hands back an opaque
 * token, the browser only ever sees the httpOnly cookie), so the *shape* of that
 * cookie has to be decided here — once, not in six copy-pasted object literals.
 * The copies had drifted: `secure` was `NODE_ENV === 'production'`, which is a
 * build-time variable, not a statement about the connection. A deployment that
 * terminates TLS in front of the app but runs its image with `NODE_ENV` unset
 * therefore handed out a session cookie *without* `Secure` — one plain-HTTP
 * request and the session belongs to whoever is on the wire.
 *
 * The decision now mirrors the kernel's `resolveCookieSecure`:
 *
 *   Secure = (x-forwarded-proto says https)  ||  API_COOKIE_SECURE is on
 *            ||  NODE_ENV === 'production'
 *
 * i.e. any single signal that says "this is a TLS deployment" wins; only a
 * plainly-http, non-production (development) request keeps it off.
 *
 * Kept free of `next/headers` so `proxy.ts` (edge runtime) can import it too;
 * the `cookies()`-based helpers live in `session-cookie.server.ts`.
 */

export const DEFAULT_SESSION_COOKIE_NAME = 'sp_session';
export const DEFAULT_SESSION_TTL_SECONDS = 43_200;

/**
 * Cookie name / lifetime. These come from `.env` rather than the kernel's
 * runtime config on purpose: the API and this process are separate deployments
 * that must agree byte for byte, so it is a deploy-time contract, not a knob an
 * administrator can flip in one of the two processes (see ADR-0026 §2.4).
 */
export function sessionCookieName(): string {
  const name = process.env.SESSION_COOKIE_NAME?.trim();
  return name && name.length > 0 ? name : DEFAULT_SESSION_COOKIE_NAME;
}

export function sessionCookieMaxAge(): number {
  const raw = Number(process.env.SESSION_TTL_SECONDS ?? DEFAULT_SESSION_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SESSION_TTL_SECONDS;
}

export interface SessionCookieSecureInput {
  /** Value of `x-forwarded-proto` for the request being answered, if any. */
  forwardedProto?: string | null;
  /** `API_COOKIE_SECURE`; shared with the kernel so both sides agree. */
  configured?: boolean | undefined;
  nodeEnv?: string | undefined;
}

/** Pure so the policy is testable without booting Next or mutating `process.env`. */
export function sessionCookieSecure(input: SessionCookieSecureInput = {}): boolean {
  const proto = input.forwardedProto?.split(',')[0]?.trim().toLowerCase();
  const configured =
    input.configured ?? process.env.API_COOKIE_SECURE?.trim().toLowerCase() === 'true';
  const nodeEnv = input.nodeEnv ?? process.env.NODE_ENV;
  // Any positive signal wins: never downgrade a TLS deployment to a plaintext
  // transport just because one of the three signals was left unset.
  return proto === 'https' || configured || nodeEnv === 'production';
}

/**
 * Ready-to-use `Set-Cookie` options. `httpOnly` is non-negotiable (the token is
 * opaque and must never be reachable from script); `sameSite: 'lax'` keeps
 * cross-site POSTs from carrying the session while letting top-level navigation
 * land on the app already signed in.
 */
export function sessionCookieOptions(input: SessionCookieSecureInput = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: sessionCookieSecure(input),
    path: '/',
    maxAge: sessionCookieMaxAge(),
  };
}
