import { AdminShell } from '@/components/admin-shell';
import type { BackendNavigationItem, BackendUser } from '@/components/backend-shell';
import { apiAssetUrl, getApiClient, getAuthedApiClient } from '@/lib/api';
import { getPluginAdminMenus } from '@/lib/admin-frontend';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

const FALLBACK_NAV: BackendNavigationItem[] = [
  { label: 'nav.dashboard', href: '/admin' },
  { label: 'nav.users', href: '/admin/users' },
  { label: 'nav.market', href: '/admin/market' },
  { label: 'nav.settings', href: '/admin/settings' },
  { label: 'nav.plugins', href: '/admin/plugins' },
  { label: 'nav.rbac', href: '/admin/rbac' },
  { label: 'nav.audit', href: '/admin/audit' },
  { label: 'nav.themes', href: '/admin/themes' },
];
/**
 * Kernel hrefs mapped to a stable group id. The shell resolves the display label
 * from the message catalog (`adminShell.group*`), so navigation never carries
 * human copy across the API boundary (ADR-0016 §2/§3).
 */
const KERNEL_GROUPS: Record<string, string> = {
  '/admin/users': 'users',
  '/admin/rbac': 'users',
  '/admin/settings': 'site',
  '/admin/themes': 'site',
  '/admin/notifications': 'site',
  '/admin/plugins': 'system',
  '/admin/market': 'system',
  '/admin/audit': 'system',
  '/admin/developer': 'developer',
};
/**
 * Admin shell with a two-row top navigation: toolbar + horizontal menu.
 * Navigation aggregates kernel defaults (`GET /nav/admin`) and active plugin contributions.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const t = createTranslator(await getLocale());
  let nav = FALLBACK_NAV;
  let pluginMenus: Awaited<ReturnType<typeof getPluginAdminMenus>> = [];
  let user: BackendUser = { email: t('admin.fallbackUser'), role: 'ADMIN' };

  try {
    const api = await getAuthedApiClient();
    const [result, menus, currentUser] = await Promise.all([
      api.getNav('admin'),
      getPluginAdminMenus(),
      api.getCurrentUser().catch(() => null),
    ]);
    nav = result.items.map((i) => ({ label: i.label, href: i.href }));
    pluginMenus = menus;
    if (currentUser) {
      user = {
        email: currentUser.user.email,
        role: currentUser.user.role,
        status: currentUser.user.status,
      };
    }
  } catch {
    // Fallback shell if the API is unreachable.
  }

  const navigationItems: BackendNavigationItem[] = [
    ...nav.map((item) => ({ ...item, group: KERNEL_GROUPS[item.href] })),
    ...pluginMenus.map((item) => ({ ...item, group: item.group ?? item.pluginId })),
  ];

  const brand = await getApiClient()
    .getPlatformBrand()
    .then((result) => result.brand)
    .catch(() => null);
  const brandLogoUrl = brand?.logo ? apiAssetUrl(brand.logo) : null;

  return (
    <AdminShell user={user} items={navigationItems} brandLogoUrl={brandLogoUrl}>
      {children}
    </AdminShell>
  );
}
