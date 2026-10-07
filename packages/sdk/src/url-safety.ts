/**
 * URL allowlist shared by the rich-text sanitizer and any other surface that
 * must decide whether a URL is safe to render (ADR-0014 §5).
 *
 * Kept dependency-free and in its own module so the SDK barrel can re-export it
 * without dragging the server-only `sanitize-html` parser into client bundles
 * (SECURITY-AUDIT-2026-10-04 I-1).
 */

/** URL allowlist: same-origin paths, fragments, and a few safe schemes. */
export function isSafeUrl(value: string, allowInlineImage = false): boolean {
  // Strip C0 control characters and whitespace that can smuggle a scheme
  // (`java\tscript:`), matching how browsers normalise URLs.
  // eslint-disable-next-line no-control-regex -- C0 controls are the attack vector here
  const compact = value.replace(/[\u0000-\u0020\u007f]+/g, '');
  if (compact.length === 0) return false;
  if (compact.startsWith('#')) return true;
  if (compact.startsWith('//')) return false; // scheme-relative, not same-origin
  if (compact.startsWith('/')) return true;
  if (/^(https?:|mailto:|tel:)/i.test(compact)) return true;
  if (allowInlineImage && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(compact)) {
    return true;
  }
  // No scheme at all → a relative path such as `images/a.png`.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(compact)) return true;
  return false;
}
