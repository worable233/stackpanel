/**
 * A throwaway origin used only to resolve/validate candidate paths. It never
 * reaches the network; comparing the resolved origin against it proves a value
 * is site-relative rather than absolute or scheme-relative.
 */
const INTERNAL_ORIGIN = 'http://stackpanel.local';

/**
 * Normalise a user/plugin-supplied `next`/redirect value to a safe
 * **same-origin** path (path + query + hash), or `null` when it is not one.
 *
 * Closes the backslash open-redirect (`/\evil.com`): browsers normalise `\` to
 * `/`, so `new URL('/\\evil.com', origin)` resolves to `http://evil.com/`. We
 * therefore reject any value containing a backslash, require a leading `/`,
 * and additionally verify the resolved origin still equals {@link
 * INTERNAL_ORIGIN} — which also rejects `//evil.com` (scheme-relative) and any
 * absolute URL. Returning the resolved path+query+hash (not the raw input)
 * means callers emit a normalised, traversal-free `Location`.
 */
export function safeInternalPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.includes('\\')) return null;
  if (!value.startsWith('/')) return null;
  let url: URL;
  try {
    url = new URL(value, INTERNAL_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== INTERNAL_ORIGIN) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
