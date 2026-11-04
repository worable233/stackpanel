import { AdminShell } from '@/components/admin-shell';
import type { BackendNavigationItem, BackendUser } from '@/components/backend-shell';
import { apiAssetUrl } from '@/lib/api';
import { getPluginAdminMenus } from '@/lib/admin-frontend';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { requestPlatformInfo, requestPlatformBrand } from '@/lib/platform-request-cache';
import { requestCurrentUser, requestNav, requestPluginAdminMenus } from '@/lib/shell-request-cache';

const FALLBACK_NAV: BackendNavigationItem[] = [
  { label: 'nav.dashboard', href: '/admin' },
  { label: 'nav.users', href: '/admin/users' },
  { label: 'nav.settings', href: '/admin/settings' },
  { label: 'nav.plugins', href: '/admin/plugins' },
  { label: 'nav.rbac', href: '/admin/rbac' },
  { label: 'nav.audit', href: '/admin/audit' },
  { label: 'nav.themes', href: '/admin/themes' },
  { label: 'nav.notifications', href: '/admin/notifications' },
  { label: 'nav.updates', href: '/admin/updates' },
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
  // 更新中心属于系统运维，与插件市场/审计同组；缺这一项时它会掉进未分组。
  '/admin/updates': 'system',
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

  let brand = null;
  let platformInfo = null;
  try {
    const [result, menus, currentUser, brandResult, platformResult] = await Promise.all([
      requestNav('admin'),
      requestPluginAdminMenus(),
      requestCurrentUser().catch(() => null),
      requestPlatformBrand(),
      requestPlatformInfo(),
    ]);
    nav = result.items.map((i) => ({ label: i.label, href: i.href }));
    pluginMenus = menus;
    brand = brandResult;
    platformInfo = platformResult;
    if (currentUser) {
      user = {
        email: currentUser.user.email,
        role: currentUser.user.role,
        status: currentUser.user.status,
        avatarUrl: currentUser.user.avatarUrl ?? null,
      };
    }
  } catch {
    // Fallback shell if the API is unreachable.
  }

  // Payment records are part of finance. The finance group is currently
  // contributed by the invoice plugin, whose group label is package-localized,
  // so reuse that label when present; otherwise fall back to the kernel
  // `nav.billing` label (same text).
  const financeGroup =
    pluginMenus.find((item) => item.pluginId === 'invoice' && item.group)?.group ??
    t('nav.billing');
  const navigationItems: BackendNavigationItem[] = [
    ...nav.map((item) => ({
      ...item,
      group: item.href === '/admin/payments' ? financeGroup : KERNEL_GROUPS[item.href],
    })),
    // 插件市场已并入 `/admin/plugins` 的「发现」页；再保留一条侧栏入口
    // 只会让同一个功能出现两次。
    ...pluginMenus
      .filter((item) => item.href !== '/admin/plugin/market')
      .map((item) => ({ ...item, group: item.group ?? item.pluginId })),
  ];

  const brandLogoUrl = brand?.logo ? apiAssetUrl(brand.logo) : null;

  return (
    <AdminShell
      user={user}
      items={navigationItems}
      brandLogoUrl={brandLogoUrl}
      brandName={platformInfo?.name}
      brandDisplay={platformInfo?.brandDisplay ?? 'both'}
    >
      {children}
    </AdminShell>
  );
}
