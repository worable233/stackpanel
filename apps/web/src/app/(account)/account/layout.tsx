import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { AccountShell } from '@/components/account-shell';
import type { BackendNavigationItem, BackendUser } from '@/components/backend-shell';
import { apiAssetUrl, getApiClient, getAuthedApiClient } from '@/lib/api';
import { getPluginAccountMenus } from '@/lib/account-frontend';
import type { PluginAccountMenu } from '@/lib/account-frontend';
import { getSessionState } from '@/lib/auth';
import { ServiceUnavailable } from '@/components/service-unavailable';

export const dynamic = 'force-dynamic';

/** Account shell with a two-row top navigation: toolbar + horizontal menu. */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const requestPath = (await headers()).get('x-stackpanel-request-path');
  const nextPath = requestPath?.startsWith('/account/') ? requestPath : '/account';
  const loginPath = `/login?next=${encodeURIComponent(nextPath)}`;
  const session = await getSessionState();
  // 只有内核**明确说**没有有效会话时才踢去登录页。
  //
  // 原先是 `if (!session) redirect(loginPath)`，而 `null` 同时代表“未登录”和
  // “问不到内核”（api 重启、超时、 5xx）。于是在 api 重启的几十秒内，所有
  // 已登录访客都被踢出登录，正在填的表单全丢——他们的会话并没有过期。
  if (session.kind === 'unavailable') return <ServiceUnavailable />;
  if (session.kind === 'anonymous') redirect(loginPath);

  const account = await loadAccountShell();
  // 同上：`null` 是“导航拉不到”，不一定是“你没登录”。
  if (!account) return <ServiceUnavailable />;

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
        group: item.href === '/account' ? undefined : 'account',
      })),
      ...sortPluginMenus(pluginMenus),
    ];
    const user: BackendUser = {
      email: currentUser.user.email,
      role: currentUser.user.role,
      status: currentUser.user.status,
      avatarUrl: currentUser.user.avatarUrl ?? null,
    };
    return { user, items };
  } catch {
    return null;
  }
}

/** Preserve plugin-owned functional groups; no business-specific fallback in the shell. */
function sortPluginMenus(menus: PluginAccountMenu[]): BackendNavigationItem[] {
  return menus;
}
