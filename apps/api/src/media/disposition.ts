/**
 * `Content-Disposition` construction (RFC 6266 / RFC 5987).
 *
 * Attachment filenames are user-controlled, so they must never reach a header
 * raw: a newline would allow response-header injection. The ASCII fallback is
 * stripped to a safe subset and the full name is carried in the RFC 5987
 * `filename*` parameter, which is UTF-8 percent-encoded.
 */

/** Build a safe `Content-Disposition` header value for `filename`. */
export class ContentDisposition {
  static build(filename: string, inline: boolean): string {
    const disposition = inline ? 'inline' : 'attachment';
    const safe = sanitizeAsciiFallback(filename);
    const encoded = encodeURIComponent(filename)
      // RFC 5987 attribute-char set: encode a few characters encodeURIComponent
      // leaves alone so the value is always valid.
      .replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${disposition}; filename="${safe}"; filename*=UTF-8''${encoded}`;
  }
}

/** Strip anything that is not printable ASCII, and quotes/backslashes. */
export function sanitizeAsciiFallback(filename: string): string {
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .trim();
  return ascii.length > 0 ? ascii : 'file';
}
