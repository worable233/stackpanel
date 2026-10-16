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
      ...navResult.items.map((item) => ({
        label: item.label,
        href: item.href,
        group: item.href === '/account' ? undefined : '账户',
      })),
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

/** Preserve plugin-owned functional groups; no business-specific fallback in the shell. */
function sortPluginMenus(menus: PluginAccountMenu[]): BackendNavigationItem[] {
  return menus.map((item) => ({ ...item, group: item.group ?? item.pluginId }));
}
