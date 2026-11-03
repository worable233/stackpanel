import 'server-only';

import type { CurrentUserResponse, NavListResponse } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
import { pinInSnapshot } from './frontend-snapshot';
import type { PluginAccountMenu } from './account-frontend';
import type { PluginAdminMenu } from './admin-frontend';

/**
 * 布局 + 页面共享的只读数据，按请求去重。
 *
 * 为什么需要：Next 的 `layout.tsx` 和它下面的 `page.tsx` 是**各自独立**执行的
 * 两个组件，它们都会去读同一份 shell 数据：
 *
 *   - `/account/settings` → `account/layout.tsx` 读 `getCurrentUser()` +
 *     `getNav('account')`，而 `account/settings/page.tsx` 自己**又**读一遍；
 *   - `/admin/*` → `admin/layout.tsx` 读 `getNav('admin')` + `getCurrentUser()`，
 *     各 admin 页面再读一次。
 *
 * 结果是每次页面渲染对同一份数据打 2~4 次内核请求（每次还带鉴权、权限计算
 * 和 DB 查询）。
 *
 * **为什么用 `pinInSnapshot` 而不是 React `cache()`**：`cache()` 只在 React 的
 * 渲染作用域里去重，而且**不合并并发调用** —— `Promise.all([f(), f()])` 仍然
 * 会执行两次。这里缓存的正是 Promise 本身，所以并发调用共享同一次请求。
 * 项目里已有的前端候选/设置解析也是同一套机制，行为一致。
 *
 * 跨请求不保留：改权限、改菜单立即生效，不需要 TTL 或失效逻辑。
 *
 * 只缓存**只读**调用。写操作绝不能走这里（缓存会把写结果丢掉）。
 */

export function requestCurrentUser(): Promise<CurrentUserResponse> {
  return pinInSnapshot('currentUser', async () => {
    const api = await getAuthedApiClient();
    return api.getCurrentUser();
  });
}

export function requestNav(surface: 'public' | 'account' | 'admin'): Promise<NavListResponse> {
  return pinInSnapshot(`nav:${surface}` as `nav:${string}`, async () => {
    const api = await getAuthedApiClient();
    return api.getNav(surface);
  });
}

export function requestPluginAccountMenus(): Promise<PluginAccountMenu[]> {
  return pinInSnapshot('pluginAccountMenus', async () => {
    const { getPluginAccountMenus } = await import('./account-frontend');
    return getPluginAccountMenus();
  });
}

export function requestPluginAdminMenus(): Promise<PluginAdminMenu[]> {
  return pinInSnapshot('pluginAdminMenus', async () => {
    const { getPluginAdminMenus } = await import('./admin-frontend');
    return getPluginAdminMenus();
  });
}
