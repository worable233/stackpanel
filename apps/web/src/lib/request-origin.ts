/**
 * Same-origin guard for cookie-authenticated BFF mutations.
 *
 * `request.nextUrl.origin` must not be used for this. Next normalizes it to the
 * host the dev server was configured with, so it disagrees with the browser's
 * `Origin` whenever the app is reached under another name — `127.0.0.1` versus
 * `localhost`, a LAN address, a proxied public domain. The result is a 403 on
 * legitimate same-origin requests (observed: `POST /api/account/avatar` from a
 * `127.0.0.1:3000` tab) with no added protection, since `Origin` and `Host` are
 * both attacker-influenced only to the extent that they disagree.
 *
 * The request's own `Host` header is the authority the browser actually talked
 * to, so that is what `Origin`'s host must equal. When a proxy tells us the
 * external scheme, it must match too; TLS termination in front of a plain-http
 * app is the common reason not to require it unconditionally.
 */
export function isSameOriginRequest(request: {
  /** Only `get` is used, so a plain header bag satisfies this too. */
  headers: { get(name: string): string | null };
}): boolean {
  const origin = request.headers.get('origin');
  // Browsers always send `Origin` on non-GET/HEAD requests, and a caller that
  // omits it is not a browser making a legitimate form/fetch call.
  if (!origin) return false;
  const firstValue = (value: string | null): string | undefined =>
    value?.split(',')[0]?.trim() || undefined;
  const host = firstValue(request.headers.get('x-forwarded-host')) ?? request.headers.get('host');
  if (!host) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.host !== host) return false;
  const proto = firstValue(request.headers.get('x-forwarded-proto'));
  // `Origin` also carries the scheme (e.g. `https://host`), so compare it against
  // what the proxy reports rather than the server's own `req.protocol`.
  if (proto && url.protocol !== `${proto}:`) return false;
  return true;
}
