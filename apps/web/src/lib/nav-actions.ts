'use server';

import { revalidatePath } from 'next/cache';
import type { AdminNavLayoutItemInput } from '@stackpanel/sdk';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

export type NavSurface = 'public' | 'account' | 'admin';

export interface NavActionResult {
  ok?: boolean;
  error?: string;
}

function revalidateNav(): void {
  revalidatePath('/admin/nav');
  revalidatePath('/admin');
}

/**
 * 保存菜单排布（对标 #12.3）。
 *
 * 服务端只做转发：链接校验、权限、审计都在内核；这里重复校验一遍没有意义，
 * 反而会让「内核拦住了但界面没提示」这种不一致更难查。
 */
export async function saveNavLayoutAction(
  surface: NavSurface,
  items: AdminNavLayoutItemInput[],
): Promise<NavActionResult> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    await api.saveAdminNavLayout(surface, items);
    revalidateNav();
    return { ok: true };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'action.navSaveFailed')) };
  }
}

export async function addNavItemAction(
  surface: NavSurface,
  input: { label: string; href: string },
): Promise<NavActionResult> {
  const locale = await getLocale();
  const label = input.label?.trim();
  const href = input.href?.trim();
  if (!label) return { error: translate(locale, 'action.navLabelRequired') };
  if (!href) return { error: translate(locale, 'action.navHrefRequired') };
  try {
    const api = await getAuthedApiClient();
    await api.addAdminNavItem(surface, { label, href });
    revalidateNav();
    return { ok: true };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'action.navAddFailed')) };
  }
}

/** 删除一条覆写：自定义项消失，默认项恢复原样。 */
export async function deleteNavItemAction(id: string): Promise<NavActionResult> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    await api.deleteAdminNavItem(id);
    revalidateNav();
    return { ok: true };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'action.navDeleteFailed')) };
  }
}
