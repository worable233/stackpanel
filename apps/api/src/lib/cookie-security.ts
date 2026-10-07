/**
 * Session-cookie security policy (SECURITY-AUDIT-2026-10-04 M-1).
 *
 * `env.API_COOKIE_SECURE` already defaults to on in production, but the flag is
 * derived from configuration an operator can silently omit or mis-set. This
 * helper is a second, independent guard applied at every `Set-Cookie` site:
 * when `NODE_ENV` is `production` the session cookie is *always* `Secure`,
 * regardless of the configured value.
 *
 * Kept as a pure function so the policy is unit-testable without booting the
 * whole app or mutating module-level env.
 */
export function resolveCookieSecure(
  configured: boolean,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  return configured || nodeEnv === 'production';
}
