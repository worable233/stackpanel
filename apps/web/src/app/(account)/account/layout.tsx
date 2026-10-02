import { redirect } from 'next/navigation';
import { AccountShell } from '@/components/account-shell';
import type { BackendNavigationItem, BackendUser } from '@/components/backend-shell';
import { apiAssetUrl, getApiClient, getAuthedApiClient } from '@/lib/api';
import { getPluginAccountMenus } from '@/lib/account-frontend';
import type { PluginAccountMenu } from '@/lib/account-frontend';
import { getSessionUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Account shell with a two-row top navigation: toolbar + horizontal menu. */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session) redirect('/login?next=/account');

  const account = await loadAccountShell();
  if (!account) redirect('/login?next=/account');

  const brand = await getApiClient()
    .getPlatformBrand()
    .then((result) => result.brand)
    .catch(() => null);
  const brandLogoUrl = brand?.logo ? apiAssetUrl(brand.logo) : null;

  return (
    <AccountShell user={account.user} items={account.items} brandLogoUrl={brandLogoUrl}>
      {children}
    </AccountShell>
  );
}

async function loadAccountShell(): Promise<{
  user: BackendUser;
  items: BackendNavigationItem[];
} | null> {
  try {
    const api = await getAuthedApiClient();
    const [currentUser, navResult, pluginMenus] = await Promise.all([
      api.getCurrentUser(),
      api.getNav('account'),
      getPluginAccountMenus(),
    ]);
    const items: BackendNavigationItem[] = [
      ...navResult.items.map((item) => ({ label: item.label, href: item.href })),
      { label: 'nav.shop', href: '/shop' },
      ...sortPluginMenus(pluginMenus),
    ];
    const user: BackendUser = {
      email: currentUser.user.email,
      role: currentUser.user.role,
      status: currentUser.user.status,
    };
    return { user, items };
  } catch {
    return null;
  }
}

/**
 * Normalize plugin menu groups to a fixed, ordered set of top-level menus so
 * the account nav stays predictable: 服务 (business objects) before 费用
 * (money). Unknown groups fall back to 服务.
 */
function sortPluginMenus(menus: PluginAccountMenu[]): BackendNavigationItem[] {
  const GROUP_KEYS: Record<string, string> = {
    服务: 'services',
    大模型: 'models',
    费用: 'billing',
  };
  const ORDER = ['services', 'models', 'billing'];
  return [...menus]
    .map((item) => ({
      label: item.label,
      href: item.href,
      group: GROUP_KEYS[item.group ?? ''] ?? 'services',
    }))
    .sort((a, b) => ORDER.indexOf(a.group ?? '') - ORDER.indexOf(b.group ?? ''));
}
