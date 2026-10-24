import type { FastifyInstance } from 'fastify';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import type { NavItem } from '@stackpanel/sdk';
import { getPrisma } from '../plugins/prisma.ts';

/**
 * 菜单显示覆写（对标 #12.3）。
 *
 * 这里只回答「怎么显示」，不回答「谁能访问」：隐藏一个菜单项不会让对应路由
 * 变得不可访问，权限仍然由路由自己的守卫决定。反过来也一样 —— 自定义链接
 * 只是多一个入口，不携带任何授权含义。
 */

export const NAV_SURFACES = ['public', 'account', 'admin'] as const;
export type NavSurface = (typeof NAV_SURFACES)[number];

/** 内核自带的菜单项。运营可以排序 / 改名 / 隐藏，但删不掉它们的存在。 */
const KERNEL_NAV: Record<NavSurface, NavItem[]> = {
  public: [],
  account: [
    { surface: 'account', label: '账户概览', href: '/account' },
    { surface: 'account', label: '账户设置', href: '/account/settings' },
    { surface: 'account', label: '我的通知', href: '/account/notifications' },
  ],
  admin: [
    { surface: 'admin', label: '工作台', href: '/admin' },
    { surface: 'admin', label: '用户管理', href: '/admin/users' },
    { surface: 'admin', label: '系统设置', href: '/admin/settings' },
    { surface: 'admin', label: '插件管理', href: '/admin/plugins' },
    { surface: 'admin', label: '权限模板', href: '/admin/rbac' },
    { surface: 'admin', label: '审计日志', href: '/admin/audit' },
    { surface: 'admin', label: 'SEO 设置', href: '/admin/seo' },
    { surface: 'admin', label: '主题管理', href: '/admin/themes' },
    { surface: 'admin', label: '通知中心', href: '/admin/notifications' },
    { surface: 'admin', label: '菜单设置', href: '/admin/nav' },
  ],
};

export const NAV_LABEL_MAX = 40;
export const NAV_HREF_MAX = 512;

export interface NavEntryRecord {
  id: string;
  surface: string;
  href: string;
  label: string | null;
  sortOrder: number | null;
  hidden: boolean;
  custom: boolean;
  updatedAt: Date;
}

/** 后台视图：解析后的菜单项 + 它来自哪里。 */
export interface ResolvedNavItem extends NavItem {
  /** 运营自己加的链接，默认菜单里没有对应项。 */
  custom: boolean;
  hidden: boolean;
  /** 是否存在覆写行；null 表示完全沿用默认。 */
  overrideId: string | null;
  /** 默认文案，前台编辑时用来提示「留空即用默认」。 */
  defaultLabel: string | null;
}

/**
 * 校验菜单链接。允许站内路径与 http(s) 绝对地址。
 *
 * 刻意不接受协议相对地址（`//evil.com`）：它看起来像站内路径，实际是外链，
 * 是开放重定向的经典伪装。
 */
export function normalizeNavHref(raw: string): string | null {
  const href = raw.trim();
  if (href.length === 0 || href.length > NAV_HREF_MAX) return null;
  if (/^\s|\s$/.test(href)) return null;
  if (href.startsWith('//')) return null;
  if (href.startsWith('/')) {
    // 站内：禁止 `javascript:`、换行注入一类的花招，只允许常规路径字符。
    return /^\/[\w\-./?=&%~+#]*$/.test(href) ? href : null;
  }
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeNavLabel(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const label = raw.trim();
  if (label.length === 0) return null;
  return label.slice(0, NAV_LABEL_MAX);
}

/** 默认菜单：内核项 + 插件声明项 + 平台开关派生的项。 */
export async function resolveBaseNav(
  app: FastifyInstance,
  surface: NavSurface,
): Promise<NavItem[]> {
  const pluginItems = app.pluginRuntime.getExtensions<NavItem>(EXTENSION_POINTS.webNav);
  const items: NavItem[] = [
    ...KERNEL_NAV[surface],
    ...pluginItems.filter((item) => item.surface === surface),
  ];
  if (surface === 'account') {
    const setting = await getPrisma().setting.findUnique({ where: { key: 'agent.enabled' } });
    const value = setting?.value;
    const enabled =
      value === true ||
      (value !== null && typeof value === 'object' && !Array.isArray(value) && value.enabled === true);
    if (enabled) items.push({ surface: 'account', label: 'Agent', href: '/account/agent' });
  }
  return items;
}

/**
 * 把覆写压到默认菜单上。
 *
 * 纯函数：排序、改名、隐藏、追加自定义项都在这里决定，路由只负责取数和鉴权。
 * 覆写行对应的默认项已经不在了（插件被卸载）时，该行只是被忽略 —— 不报错，
 * 因为那是运营无法避免的情况，不该让整个菜单 500。
 */
function decorate(
  base: NavItem[],
  entries: NavEntryRecord[],
  surface: NavSurface,
): Array<ResolvedNavItem & { order: number; seq: number }> {
  const byHref = new Map<string, NavEntryRecord>();
  for (const entry of entries) byHref.set(entry.href, entry);

  const decorated: Array<ResolvedNavItem & { order: number; seq: number }> = [];
  base.forEach((item, index) => {
    const entry = byHref.get(item.href);
    byHref.delete(item.href);
    decorated.push({
      surface,
      href: item.href,
      label: entry?.label ?? item.label,
      custom: false,
      hidden: entry?.hidden ?? false,
      overrideId: entry?.id ?? null,
      defaultLabel: item.label,
      order: entry?.sortOrder ?? index,
      seq: index,
    });
  });

  // 剩下的行有两种：运营自定义的链接（补进来），以及对应的默认项已经消失的
  // 覆写行（插件被卸载）。后者不补进菜单 —— 它不是运营加的入口，补进来就是
  // 凭空多出一个可能 404 的链接。留着行本身，插件装回来时配置还在。
  let extra = base.length;
  for (const entry of byHref.values()) {
    if (!entry.custom) continue;
    decorated.push({
      surface,
      href: entry.href,
      label: entry.label ?? entry.href,
      custom: true,
      hidden: entry.hidden,
      overrideId: entry.id,
      defaultLabel: null,
      order: entry.sortOrder ?? extra++,
      seq: Number.MAX_SAFE_INTEGER,
    });
  }

  decorated.sort((a, b) => a.order - b.order || a.seq - b.seq);
  return decorated;
}

function strip(decorated: Array<ResolvedNavItem & { order: number; seq: number }>): ResolvedNavItem[] {
  return decorated.map(({ order: _order, seq: _seq, ...item }) => item);
}

/**
 * 把覆写压到默认菜单上。
 *
 * 纯函数：排序、改名、隐藏、追加自定义项都在这里决定，路由只负责取数和鉴权。
 * 覆写行对应的默认项已经不在了（插件被卸载）时，该行只是被忽略 —— 不报错，
 * 因为那是运营无法避免的情况，不该让整个菜单 500。
 */
export function applyNavEntries(
  base: NavItem[],
  entries: NavEntryRecord[],
  surface: NavSurface,
): ResolvedNavItem[] {
  return strip(decorate(base, entries, surface)).filter((item) => !item.hidden);
}

/** 后台视图：保留隐藏项（「被隐藏的菜单」也要能改回来），顺序与真实渲染一致。 */
export function applyNavEntriesIncludingHidden(
  base: NavItem[],
  entries: NavEntryRecord[],
  surface: NavSurface,
): ResolvedNavItem[] {
  return strip(decorate(base, entries, surface));
}

export async function listNavEntries(surface?: NavSurface): Promise<NavEntryRecord[]> {
  const rows = await getPrisma().navEntry.findMany({
    where: surface ? { surface } : {},
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return rows;
}

export async function upsertNavEntry(input: {
  surface: NavSurface;
  href: string;
  label?: string | null;
  sortOrder?: number | null;
  hidden?: boolean;
  custom?: boolean;
  updatedBy?: string | null;
}): Promise<NavEntryRecord> {
  const data = {
    label: input.label ?? null,
    sortOrder: input.sortOrder ?? null,
    hidden: input.hidden ?? false,
    custom: input.custom ?? false,
    updatedBy: input.updatedBy ?? null,
  };
  return getPrisma().navEntry.upsert({
    where: { surface_href: { surface: input.surface, href: input.href } },
    create: { id: crypto.randomUUID(), surface: input.surface, href: input.href, ...data },
    update: data,
  });
}

export async function deleteNavEntry(id: string): Promise<boolean> {
  const result = await getPrisma().navEntry.deleteMany({ where: { id } });
  return result.count > 0;
}

export async function deleteNavEntryByHref(
  surface: NavSurface,
  href: string,
): Promise<boolean> {
  const result = await getPrisma().navEntry.deleteMany({ where: { surface, href } });
  return result.count > 0;
}
