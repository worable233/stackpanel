/**
 * Browser-facing URLs for kernel-served assets.
 *
 * Deliberately free of `server-only`: client components need to build `<img src>`
 * from a kernel-relative path the API hands out (an avatar, for instance), and
 * they must never embed `API_BASE_URL` — that address is host-local, so a browser
 * anywhere else would try to reach its own machine.
 *
 * The single egress is the web BFF route `app/api/plugins/[...path]/route.ts`,
 * which forwards `/api/plugins/<kernel-path>` to `{API_BASE_URL}/<kernel-path>`
 * (same-origin, binary-safe, session-aware: it attaches the session token when the
 * visitor has one and forwards anonymously otherwise).
 */
export const KERNEL_BFF_PREFIX = '/api/plugins';

/** Resolve a kernel-relative resource path to a same-origin, BFF-served URL. */
export function kernelAssetUrl(assetPath: string | null | undefined): string {
  if (!assetPath) return '';
  if (/^https?:\/\//.test(assetPath)) return assetPath;
  return `${KERNEL_BFF_PREFIX}${assetPath.startsWith('/') ? '' : '/'}${assetPath}`;
}
