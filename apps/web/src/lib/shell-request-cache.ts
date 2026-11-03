import 'server-only';

import { cache } from 'react';
import type { CurrentUserResponse, NavListResponse } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
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
 * **为什么用 React `cache()`**：实测证明 `AsyncLocalStorage` 的 `enterWith`
 * 作用域不跨渲染阶段（layout 与 page、`generateMetadata` 与页面组件之间都
 * 不共享），用它做去重实测无效——`/account` 单次渲染仍然打 2 次
 * `/platform/info` 和 2 次 `/permissions/check`。`cache()` 由 Next 绑定到同一次
 * 渲染，跨这些阶段共享。
 *
 * 跨请求不保留：改权限、改菜单立即生效，不需要 TTL 或失效逻辑。
 *
 * 只缓存**只读**调用。写操作绝不能走这里（缓存会把写结果丢掉）。
 */

export const requestCurrentUser = cache(async (): Promise<CurrentUserResponse> => {
  const api = await getAuthedApiClient();
  return api.getCurrentUser();
});

export const requestNav = cache(
  async (surface: 'public' | 'account' | 'admin'): Promise<NavListResponse> => {
    const api = await getAuthedApiClient();
    return api.getNav(surface);
  },
);

/**
 * 权限检查，按 (权限, 请求) 去重。
 *
 * 一次渲染里同一个权限会被查多次：账号/后台的菜单构建、路由守卫、
 * 插件 action 绑定各自调用 `checkPermission`。权限在一次请求内不会变，
 * 重复查只是重复打内核（实测单次 `/account` 渲染查 2 次同一权限）。
 */
export const requestPermission = cache(async (permission: string): Promise<boolean> => {
  const api = await getAuthedApiClient();
  try {
    return (await api.checkPermission(permission)).allowed;
  } catch {
    return false;
  }
});

export const requestPluginAccountMenus = cache(async (): Promise<PluginAccountMenu[]> => {
  const { getPluginAccountMenus } = await import('./account-frontend');
  return getPluginAccountMenus();
});

export const requestPluginAdminMenus = cache(async (): Promise<PluginAdminMenu[]> => {
  const { getPluginAdminMenus } = await import('./admin-frontend');
  return getPluginAdminMenus();
});
