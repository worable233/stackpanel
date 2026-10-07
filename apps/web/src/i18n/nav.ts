/**
 * Kernel navigation label mapping (ADR-0016 §2).
 *
 * The API returns neutral, language-independent navigation entries identified by
 * a stable `href`. The UI resolves the display label from the active locale's
 * message directory, so kernel menus localise without the API knowing the
 * request language (ADR-0016 §3). Plugin-contributed menus stay as-is until the
 * manifest `locales` field lands (ADR-0016 §5).
 */
const NAV_KEYS: Record<string, string> = {
  '/admin': 'nav.dashboard',
  '/admin/users': 'nav.users',
  '/admin/market': 'nav.market',
  '/admin/settings': 'nav.settings',
  '/admin/plugins': 'nav.plugins',
  '/admin/rbac': 'nav.rbac',
  '/admin/audit': 'nav.audit',
  '/admin/themes': 'nav.themes',
  '/admin/notifications': 'nav.notifications',
  '/account': 'nav.dashboard',
  '/account/security': 'nav.security',
  '/account/api-keys': 'nav.apiKeys',
  '/account/notifications': 'nav.notifications',
  '/shop': 'nav.shop',
};

/** Message key for a known kernel navigation href, or `null` if unknown. */
export function navMessageKey(href: string): string | null {
  return NAV_KEYS[href] ?? null;
}
