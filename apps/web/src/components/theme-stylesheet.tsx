import { getApiClient } from '@/lib/api';

/**
 * Injects a <link> to the active theme's stylesheet from the API. Theming is
 * fully dynamic: switching the active theme changes the served CSS without a
 * web rebuild. The @theme inline token mapping in globals.css resolves the
 * CSS variables at runtime from whichever theme.css is active.
 */
export default async function ThemeStylesheet() {
  const apiBase = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
  let href: string | null = null;
  try {
    const { theme } = await getApiClient().getActiveTheme();
    if (theme) {
      href = `${apiBase}/themes/${theme.id}/theme.css`;
    }
  } catch {
    href = null;
  }
  return href ? <link rel="stylesheet" href={href} /> : null;
}
