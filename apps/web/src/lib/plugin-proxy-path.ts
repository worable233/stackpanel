/**
 * Pure, framework-free path normalisation for the plugin BFF proxy.
 *
 * Extracted from the route handler so the security-critical decoding can be
 * unit-tested without booting Next's request machinery.
 */

/**
 * Decode each path segment **once more** and reject anything that could
 * traverse or hide a traversal after `new URL()` normalisation.
 *
 * The framework decodes the URL once, so `%252e%252e` arrives as `%2e%2e`
 * (≠ `..`) and slips past a literal check; a second decode turns it into `..`.
 * We therefore normalise every segment and refuse:
 *   - anything that still decodes (a `%` survived) — double-encoding tricks,
 *   - `.` / `..` / empty segments — path traversal,
 *   - `/` or `\` — segment separators smuggled inside one segment.
 *
 * Returns the decoded segments, or `null` when the path is unsafe.
 */
export function decodeSegmentsSafely(segments: string[]): string[] | null {
  const decoded: string[] = [];
  for (const raw of segments) {
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return null; // malformed percent-encoding
    }
    // A surviving `%` means it was double-encoded: reject outright.
    if (value.includes('%') || value.includes('/') || value.includes('\\')) return null;
    if (value === '' || value === '.' || value === '..') return null;
    decoded.push(value);
  }
  return decoded;
}

/** Plugin namespace / theme id shape; mirrors the kernel's route patterns. */
const NAMESPACE_PATTERN = /^[a-z0-9_-]{1,64}$/;

/**
 * Public kernel resources the browser may load **without a session**: brand
 * assets, theme CSS, theme assets, and compiled frontend packages (theme &
 * plugin) — the latter required by PLAN-github-distribution-and-updates §6.6,
 * because the browser imports them before login and they are kernel static
 * resources, not plugin business routes, so they never appear in the plugin
 * action-target table.
 *
 * Everything else must pass the authenticated action-target check in the route.
 */
export function isPublicAssetRequest(method: string, segments: string[]): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (segments[0] === 'platform' && segments.length === 3) {
    return segments[1] === 'brand' && (segments[2] === 'logo' || segments[2] === 'favicon');
  }
  if (segments[0] === 'plugins' && segments.length >= 4) {
    return (
      NAMESPACE_PATTERN.test(segments[1] ?? '') &&
      segments[2] === 'frontend' &&
      isAssetTail(segments, 3)
    );
  }
  if (
    segments[0] !== 'themes' ||
    segments.length < 3 ||
    !NAMESPACE_PATTERN.test(segments[1] ?? '')
  ) {
    return false;
  }
  if (segments.length === 3 && segments[2] === 'theme.css') return true;
  if (segments[2] === 'frontend' && segments.length > 3 && isAssetTail(segments, 3)) return true;
  // Theme assets are served by the API's path-safe /themes/:id/assets/* route.
  return segments[2] === 'assets' && segments.length > 3 && isAssetTail(segments, 3);
}

/** Whether `segments[from..]` is a non-empty, traversal-free asset path. */
function isAssetTail(segments: string[], from: number): boolean {
  const tail = segments.slice(from);
  return tail.length > 0 && !tail.some((part) => part === '..' || part === '');
}
