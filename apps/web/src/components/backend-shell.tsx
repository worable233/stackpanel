'use client';

import type { LucideIcon } from 'lucide-react';
import { ArrowLeft, ArrowRightLeft, ChevronDown, LogOut, PanelsTopLeft, User } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationBell } from '@/components/notification-bell';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { localeOptions } from '@/i18n/core';
import { navMessageKey } from '@/i18n/nav';
import { useLocale, useTranslator } from '@/i18n/provider';
import { logoutAction } from '@/lib/actions';
import { cn } from '@/lib/utils';

/** Known navigation groups mapped to their message key. */
const GROUP_MESSAGE_KEYS: Record<string, string> = {
  plugins: 'nav.groupPlugins',
  services: 'nav.services',
  models: 'nav.models',
  billing: 'nav.billing',
};

export interface BackendUser {
  email: string;
  role: 'ADMIN' | 'USER';
  status?: 'ACTIVE' | 'DISABLED';
}

export interface BackendNavigationItem {
  href: string;
  label: string;
  group?: string;
}

export interface BackendShellProps {
  user: BackendUser;
  items: BackendNavigationItem[];
  rootHref: string;
  navigationIcons: Record<string, LucideIcon>;
  defaultIcon?: LucideIcon;
  groupLabels?: Record<string, string>;
  /** Icon for each group's top-level trigger button. */
  groupIcons?: Record<string, LucideIcon>;
  /** Max width of the header, nav and content wrappers (a Tailwind `max-w-*` class). */
  contentMaxWidth?: string;
  backLink?: { label: string; href: string; messageKey?: string };
  /** Absolute URL to the active theme's brand logo, when the platform provides one. */
  brandLogoUrl?: string | null;
  children: React.ReactNode;
}

function isActive(pathname: string, href: string, rootHref: string): boolean {
  if (href === rootHref) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * 只允许导航里**一个**条目处于选中态：精确命中优先，否则取最长的前缀命中。
 *
 * 之前逐条 `isActive` 会把 `/account/gateway` 与 `/account/gateway/pricing`
 * 同时点亮（前者是后者的前缀）——同一个下拉里两行都选中。这里先在整个导航集合上
 * 选出唯一「最具体」的 href，再由各条目比较自身是否等于它。
 */
function resolveActiveHref(pathname: string, hrefs: string[], rootHref: string): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    if (!isActive(pathname, href, rootHref)) continue;
    // 根项只认精确命中，且不参与“更长前缀”比较。
    if (href === rootHref) {
      if (pathname === href) return href;
      continue;
    }
    if (best === null || href.length > best.length) best = href;
  }
  return best;
}

function UserDropdown({
  user,
  backLink,
  rootHref,
}: {
  user: BackendUser;
  backLink?: BackendShellProps['backLink'];
  rootHref: string;
}) {
  const t = useTranslator();
  const initial = user.email.charAt(0).toUpperCase();
  const roleLabel = user.role === 'ADMIN' ? t('nav.roleAdmin') : t('nav.roleUser');
  const healthy = user.status === 'ACTIVE' || !user.status;
  const isAdminArea = rootHref === '/admin';
  const switchTarget = isAdminArea
    ? { href: '/account', label: t('nav.switchToAccount') }
    : { href: '/admin', label: t('nav.switchToAdmin') };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="relative h-9 gap-2 pl-1 pr-2 text-foreground/80 hover:bg-accent hover:text-foreground"
          >
            <div className="relative">
              <div className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-xs font-semibold text-primary-foreground">
                {initial}
              </div>
              <span
                className={cn(
                  'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background',
                  healthy ? 'bg-success' : 'bg-warning',
                )}
              />
            </div>
            <span className="hidden max-w-[200px] truncate text-sm sm:inline">{user.email}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-56">
        <div className="flex items-start gap-3 px-3 py-2.5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-sm font-semibold text-primary-foreground">
            {initial}
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="truncate text-sm font-semibold text-popover-foreground">{user.email}</p>
            <span className="mt-1 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary ring-1 ring-primary/10">
              {roleLabel}
            </span>
          </div>
        </div>
        <DropdownMenuSeparator />
        {backLink ? (
          <DropdownMenuItem
            render={
              <Link href={backLink.href} className="flex items-center gap-2">
                <ArrowLeft className="size-4" />
                <span>{backLink.messageKey ? t(backLink.messageKey) : backLink.label}</span>
              </Link>
            }
          />
        ) : null}
        {user.role === 'ADMIN' ? (
          <DropdownMenuItem
            render={
              <Link href={switchTarget.href} className="flex items-center gap-2">
                <ArrowRightLeft className="size-4" />
                <span>{switchTarget.label}</span>
              </Link>
            }
          />
        ) : null}
        <DropdownMenuItem onClick={() => logoutAction()} variant="destructive">
          <LogOut className="size-4" />
          {t('nav.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavButton({
  item,
  label,
  activeHref,
  icons,
  defaultIcon,
}: {
  item: BackendNavigationItem;
  label: string;
  activeHref: string | null;
  icons: Record<string, LucideIcon>;
  defaultIcon?: LucideIcon;
}) {
  const active = item.href === activeHref;
  const Icon = icons[item.href] ?? defaultIcon ?? User;

  return (
    <Button
      render={<Link href={item.href} aria-current={active ? 'page' : undefined} />}
      variant="ghost"
      className={cn(
        'relative h-9 gap-2 px-3 text-sm',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-foreground/70 hover:bg-accent hover:text-foreground',
      )}
    >
      <Icon className="size-4" />
      <span className="truncate">{label}</span>
    </Button>
  );
}

function NavDropdown({
  group: _group,
  groupLabel,
  items,
  label,
  activeHref,
  icons,
  groupIcons,
  defaultIcon,
}: {
  group: string;
  groupLabel: string;
  items: BackendNavigationItem[];
  label: (item: BackendNavigationItem) => string;
  activeHref: string | null;
  icons: Record<string, LucideIcon>;
  groupIcons?: Record<string, LucideIcon>;
  defaultIcon?: LucideIcon;
}) {
  const anyActive = items.some((item) => item.href === activeHref);
  const Icon = groupIcons?.[_group] ?? defaultIcon ?? User;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className={cn(
              'relative h-9 gap-2 px-3 text-sm',
              anyActive
                ? 'bg-primary/10 text-primary'
                : 'text-foreground/70 hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
            <span className="truncate">{groupLabel}</span>
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-40">
        {items.map((item) => {
          const ItemIcon = icons[item.href] ?? defaultIcon ?? User;
          const active = item.href === activeHref;
          return (
            <DropdownMenuItem
              key={item.href}
              render={
                <Link
                  href={item.href}
                  className={cn('flex items-center gap-2', active && 'bg-primary/10 text-primary')}
                  aria-current={active ? 'page' : undefined}
                />
              }
            >
              <ItemIcon className="size-4" />
              <span>{label(item)}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Two-row backend shell: top toolbar + horizontal navigation bar.
 *  This is the client-side generic base; import AdminShell/AccountShell from server layouts. */
export function BackendShell({
  user,
  items,
  rootHref,
  navigationIcons,
  defaultIcon,
  groupLabels,
  groupIcons,
  contentMaxWidth = 'max-w-[1440px]',
  backLink,
  brandLogoUrl,
  children,
}: BackendShellProps) {
  const directItems = items.filter((item) => !item.group);
  const groups = new Map<string, BackendNavigationItem[]>();
  for (const item of items) {
    if (!item.group) continue;
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  }

  const pathname = usePathname();
  const locale = useLocale();
  const t = useTranslator();
  const activeHref = resolveActiveHref(
    pathname,
    items.map((item) => item.href),
    rootHref,
  );
  const label = (item: BackendNavigationItem): string => {
    const key = navMessageKey(item.href);
    return key ? t(key) : item.label;
  };

  return (
    <div className="flex min-h-dvh flex-col bg-muted/30">
      <header className="h-16 border-b bg-background/85 backdrop-blur">
        <div className={cn('mx-auto flex h-full w-full items-center justify-between gap-4 px-4 sm:px-6 lg:px-10', contentMaxWidth)}>
          <Link
            href={rootHref}
            className={cn(
              'flex size-8 items-center justify-center overflow-hidden rounded-md',
              brandLogoUrl ? 'bg-transparent' : 'bg-primary text-primary-foreground',
            )}
            aria-label={t('nav.homeAriaLabel')}
          >
            {brandLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brandLogoUrl} alt="" className="size-8 object-contain" />
            ) : (
              <PanelsTopLeft className="size-4" />
            )}
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <NotificationBell inboxHref={`${rootHref}/notifications`} />
            <LocaleSwitcher
              locale={locale}
              items={localeOptions()}
              ariaLabel={t('localeSwitcher.ariaLabel')}
            />
            <ThemeToggle />
            <UserDropdown user={user} backLink={backLink} rootHref={rootHref} />
          </div>
        </div>
      </header>

      <nav className="border-b bg-background">
        <div className={cn('mx-auto flex h-12 w-full items-center gap-1 overflow-x-auto px-4 sm:px-6 lg:px-10', contentMaxWidth)}>
          {directItems.map((item) => (
            <NavButton
              key={item.href}
              item={item}
              label={label(item)}
              activeHref={activeHref}
              icons={navigationIcons}
              defaultIcon={defaultIcon}
            />
          ))}
          {Array.from(groups.entries()).map(([group, groupItems]) => (
            <NavDropdown
              key={group}
              group={group}
              groupLabel={
                groupLabels?.[group] ??
                (GROUP_MESSAGE_KEYS[group] ? t(GROUP_MESSAGE_KEYS[group]) : group)
              }
              items={groupItems}
              label={label}
              activeHref={activeHref}
              icons={navigationIcons}
              groupIcons={groupIcons}
              defaultIcon={defaultIcon}
            />
          ))}
        </div>
      </nav>

      <main className="flex-1 overflow-x-hidden">
        <div className={cn('mx-auto w-full px-4 py-8 sm:px-6 lg:px-10 lg:py-10', contentMaxWidth)}>
          {children}
        </div>
      </main>
    </div>
  );
}
