import { apiAssetUrl, getApiClient } from '@/lib/api';

/**
 * Injects a <link> to the active theme's stylesheet from the API. Theming is
 * fully dynamic: switching the active theme changes the served CSS without a
 * web rebuild. The @theme inline token mapping in globals.css resolves the
 * CSS variables at runtime from whichever theme.css is active.
 *
 * The stylesheet is fetched through the same-origin BFF (`apiAssetUrl`) so the
 * browser never needs the server-only API origin.
 */
export default async function ThemeStylesheet() {
  // The setup page is available before an instance has an active theme (and
  // during the short window while the API is seeding the built-in theme). Keep
  // the host styled in that state instead of falling back to browser defaults.
  let href: string | null = apiAssetUrl('/themes/default/theme.css');
  try {
    const { theme } = await getApiClient().getActiveTheme();
    if (theme) {
      href = apiAssetUrl(`/themes/${theme.id}/theme.css`);
    }
  } catch {
    // Keep the built-in default stylesheet as a deterministic fallback.
  }
  return href ? <link rel="stylesheet" href={href} /> : null;
}
