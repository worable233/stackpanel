/**
 * Theme seam shared by the server bootstrap script and the client provider.
 *
 * Kept dependency-free and importable from both server and client components:
 * the storage key must be identical on both sides, and the bootstrap script is
 * rendered inline by the server root layout.
 */

/** `localStorage` key holding the user's preference (`light` | `dark` | `system`). */
export const THEME_STORAGE_KEY = 'theme';

export type Theme = 'light' | 'dark' | 'system';

/** The concrete theme actually applied to `<html>` once `system` is resolved. */
export type ResolvedTheme = 'light' | 'dark';

/**
 * Pre-paint bootstrap: resolve the stored (or system) theme and put the matching
 * class on `<html>` before first paint, so there is no flash of the wrong theme.
 *
 * Rendered inline by the server `RootLayout` (a Server Component), never by a
 * client component — which is exactly why React 19 no longer warns about a
 * client-rendered `<script>` that would never execute. Must stay in sync with
 * the provider: same storage key, same `class` attribute, same `color-scheme`.
 */
export const themeBootstrapScript = `(function(){try{var e=document.documentElement,t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)}),m=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',r=t==='light'||t==='dark'?t:m;e.classList.add(r);e.style.colorScheme=r}catch(e){}})();`;
