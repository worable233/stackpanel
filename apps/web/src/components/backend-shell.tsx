'use client';

import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  ArrowRightLeft,
  ChevronDown,
  Gauge,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  PanelsTopLeft,
  Settings,
  Sun,
  User,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { BackendToolbarButton } from '@/components/backend-toolbar-button';
import { BackendSearch } from '@/components/backend-search';
import { useTheme } from '@/components/theme-provider';
import { NotificationBell } from '@/components/notification-bell';
import { NotificationToaster } from '@/components/notification-toaster';
import { BackendRouteProgress } from '@/components/backend-route-progress';
import { AgentSidebar } from '@/components/agent-sidebar';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { localeOptions } from '@/i18n/core';
import { navMessageKey } from '@/i18n/nav';
import { useLocale, useTranslator } from '@/i18n/provider';
import { logoutAction } from '@/lib/actions';
import { cn } from '@/lib/utils';
import {
  groupBackendNavigation,
  isBackendOverview,
  resolveBackendActiveItem,
  type BackendNavigationItem,
} from '@/lib/backend-navigation';
export type { BackendNavigationItem } from '@/lib/backend-navigation';

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
  const { setTheme } = useTheme();
  const initial = user.email.charAt(0).toUpperCase();
  const displayName = user.email.split('@')[0] || user.email;
  const isAdminArea = rootHref === '/admin';
  const switchTarget = isAdminArea
    ? { href: '/account', label: t('nav.switchToAccount') }
    : { href: '/admin', label: t('nav.switchToAdmin') };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <BackendToolbarButton aria-label={user.email}>
            <Avatar className="size-9">
              <AvatarFallback className="bg-muted text-sm font-medium text-foreground">
                {initial}
              </AvatarFallback>
            </Avatar>
          </BackendToolbarButton>
        }
      />
      <DropdownMenuContent align="end" className="w-64 min-w-0 p-1">
        <div className="border-b px-2 py-2.5">
          <p className="truncate text-sm font-semibold leading-tight text-muted-foreground">
            {displayName}
          </p>
          <p className="mt-1 truncate text-sm leading-tight text-muted-foreground">{user.email}</p>
        </div>
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href="/account" className="flex items-center gap-2" />}>
            <User className="size-4" />
            账户概览
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link href="/account/security" className="flex items-center gap-2" />}
          >
            <Settings className="size-4" />
            账户设置
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link href="/account/api-keys" className="flex items-center gap-2" />}
          >
            <KeyRound className="size-4" />
            访问凭证
          </DropdownMenuItem>
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
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => setTheme('system')}>
            <Monitor className="size-4" />
            跟随系统
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme('light')}>
            <Sun className="size-4" />
            亮色
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme('dark')}>
            <Moon className="size-4" />
            暗色
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => logoutAction()} variant="destructive">
            <LogOut className="size-4" />
            {t('nav.logout')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavButton({
  item,
  label,
  activeHref,
}: {
  item: BackendNavigationItem;
  label: string;
  activeHref: string | null;
  icons: Record<string, LucideIcon>;
  defaultIcon?: LucideIcon;
}) {
  const active = item.href === activeHref;

  return (
    <Button
      render={<Link href={item.href} aria-current={active ? 'page' : undefined} />}
      variant="ghost"
      className={cn(
        'relative h-9 gap-1.5 rounded-xl bg-transparent px-3 text-sm font-medium shadow-none hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent transition-colors duration-200 motion-reduce:transition-none',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="truncate">{label}</span>
    </Button>
  );
}

function NavDropdown({
  groupLabel,
  items,
  label,
  activeHref,
  icons,
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className={cn(
              'relative h-9 gap-1.5 rounded-xl bg-transparent px-3 text-sm font-medium shadow-none hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent transition-colors duration-200 motion-reduce:transition-none',
              anyActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="truncate">{groupLabel}</span>
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuGroup>
          {items.map((item) => {
            const ItemIcon = isBackendOverview(item) ? Gauge : icons[item.href] ?? defaultIcon ?? User;
            const active = item.href === activeHref;
            return (
              <DropdownMenuItem
                key={item.href}
                render={
                  <Link
                    href={item.href}
                    className={cn(
                      'flex items-center gap-2',
                      active && 'bg-secondary text-secondary-foreground',
                    )}
                    aria-current={active ? 'page' : undefined}
                  />
                }
              >
                <ItemIcon className="size-4" />
                <span>{label(item)}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Horizontal backend header, with a second navigation row on smaller screens.
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
  const [agentOpen, setAgentOpen] = useState(false);
  const directItems = items.filter((item) => !item.group);
  const groups = groupBackendNavigation(items);

  const pathname = usePathname();
  const locale = useLocale();
  const t = useTranslator();
  const activeItem = resolveBackendActiveItem(pathname, items, rootHref);
  const activeHref = activeItem?.href ?? null;
  const label = (item: BackendNavigationItem): string => {
    if (isBackendOverview(item)) return locale === 'en-US' ? 'Overview' : '概览';
    const key = navMessageKey(item.href);
    return key ? t(key) : item.label;
  };

  return (
    <div className="backend-shell relative isolate flex min-h-dvh flex-col bg-background text-foreground">
      <BackendRouteProgress />
      <NotificationToaster />
      <div className="backend-shell__glow pointer-events-none absolute inset-x-0 top-0 z-0 h-96" />
      <div className="backend-shell__header sticky top-0 z-30 bg-background/55 backdrop-blur-2xl">
        <header
          className={cn(
            'relative mx-auto grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-4 px-4 sm:px-6 lg:px-8 xl:h-16',
            contentMaxWidth,
          )}
        >
          <Link
            href={rootHref}
            className="my-4 flex size-8 items-center justify-center overflow-hidden"
            aria-label={t('nav.homeAriaLabel')}
          >
            {brandLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brandLogoUrl} alt="" className="size-8 object-contain" />
            ) : (
              <PanelsTopLeft className="size-4" />
            )}
          </Link>
          <nav
            aria-label={t('nav.homeAriaLabel')}
            className="col-span-3 row-start-2 min-w-0 border-t border-border/50 pt-1 xl:col-span-1 xl:col-start-2 xl:row-start-1 xl:border-t-0 xl:border-l xl:border-border/50 xl:pl-4"
          >
            <div className="scrollbar-none flex h-12 min-w-0 items-center gap-2 overflow-x-auto xl:h-auto">
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
          <div className="col-start-3 row-start-1 flex shrink-0 items-center gap-1 sm:gap-2">
            <BackendSearch
              items={items.map((item) => ({
                href: item.href,
                label: label(item),
                groupLabel: item.group
                  ? (groupLabels?.[item.group] ??
                    (GROUP_MESSAGE_KEYS[item.group]
                      ? t(GROUP_MESSAGE_KEYS[item.group])
                      : item.group))
                  : undefined,
              }))}
            />
            <AgentSidebar open={agentOpen} onOpenChange={setAgentOpen} contextLabel={rootHref === '/admin' ? '管理员工作区' : '账户工作区'} />
            <NotificationBell inboxHref={`${rootHref}/notifications`} />
            <LocaleSwitcher
              locale={locale}
              items={localeOptions()}
              ariaLabel={t('localeSwitcher.ariaLabel')}
              iconOnly
            />
            <UserDropdown user={user} backLink={backLink} rootHref={rootHref} />
          </div>
        </header>
      </div>

      <main className="relative z-[1] flex-1 overflow-x-clip">
        <div className={cn('mx-auto w-full px-4 py-8 sm:px-6 lg:px-8 lg:py-10', contentMaxWidth)}>
          <div className="min-w-0">{children}</div>
        </div>
      </main>
    </div>
  );
}
