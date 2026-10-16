/**
 * Referral attribution on the Web BFF.
 *
 * `apps/web/src/proxy.ts` writes this cookie when a visitor lands on
 * `?affid=<code>`; the register action reads it back and hands the code to the
 * API. The Web layer never validates a code — it only carries it — so the
 * owning plugin stays the single authority on what a code means.
 */
export const AFFILIATE_COOKIE = process.env.AFFILIATE_COOKIE_NAME ?? 'sp_aff';

/** Referral codes are short opaque tokens. */
const AFFILIATE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Normalize a cookie value into a code we are willing to forward. */
export function normalizeAffiliateCode(value: string | undefined | null): string | null {
  if (!value) return null;
  const code = value.trim();
  return AFFILIATE_CODE_PATTERN.test(code) ? code : null;
}
