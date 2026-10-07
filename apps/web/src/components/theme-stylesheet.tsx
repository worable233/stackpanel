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
  let href: string | null = null;
  try {
    const { theme } = await getApiClient().getActiveTheme();
    if (theme) {
      href = apiAssetUrl(`/themes/${theme.id}/theme.css`);
    }
  } catch {
    href = null;
  }
  return href ? <link rel="stylesheet" href={href} /> : null;
}
