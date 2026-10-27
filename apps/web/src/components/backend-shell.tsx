'use client';

import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  ArrowRightLeft,
  BrainCircuit,
  ChevronRight,
  Folder,
  Gauge,
  Globe2,
  HelpCircle,
  KeyRound,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsTopLeft,
  Server,
  Settings,
  Sun,
  User,
  Users,
  Wallet,
  Blocks,
  Monitor,
  Moon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
} from '@/components/ui/sidebar';
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
import { useTheme } from '@/components/theme-provider';
import { NotificationBell } from '@/components/notification-bell';
import { NotificationToaster } from '@/components/notification-toaster';
import { BackendRouteProgress } from '@/components/backend-route-progress';
import { AgentSidebar } from '@/components/agent-sidebar';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import * as AnimateSidebar from '@animate-ui/react/primitives/sidebar';
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
  users: 'adminShell.groupUsers',
  site: 'adminShell.groupSite',
  system: 'adminShell.groupSystem',
  developer: 'adminShell.groupDeveloper',
  account: 'adminShell.groupAccount',
};

const GROUP_ICONS: Record<string, LucideIcon> = {
  users: Users,
  site: Globe2,
  system: Settings,
  developer: Blocks,
  account: User,
  plugins: Blocks,
  services: Server,
  models: BrainCircuit,
  billing: Wallet,
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
        <DropdownMenuGroup className="mt-1">
          <DropdownMenuItem render={<Link href="/account" className="flex items-center gap-2" />}>
            <User className="size-4" />
            {t('nav.accountOverview')}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link href="/account/settings" className="flex items-center gap-2" />}
          >
            <Settings className="size-4" />
            {t('account.settings.title')}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link href="/account/settings#security" className="flex items-center gap-2" />}
          >
            <KeyRound className="size-4" />
            {t('nav.credentials')}
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
            {t('theme.system')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme('light')}>
            <Sun className="size-4" />
            {t('theme.light')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme('dark')}>
            <Moon className="size-4" />
            {t('theme.dark')}
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

function SidebarNav({
  items,
  groups,
  activeHref,
  label,
  icons,
  defaultIcon,
  collapsed,
  onNavigate,
  ariaLabel,
}: {
  items: BackendNavigationItem[];
  groups: { key: string; label: string; items: BackendNavigationItem[]; defaultOpen: boolean; icon: LucideIcon }[];
  activeHref: string | null;
  label: (item: BackendNavigationItem) => string;
  icons: Record<string, LucideIcon>;
  defaultIcon?: LucideIcon;
  collapsed: boolean;
  onNavigate?: () => void;
  ariaLabel: string;
}) {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const itemIcon = (item: BackendNavigationItem): LucideIcon =>
    isBackendOverview(item) ? Gauge : (icons[item.href] ?? defaultIcon ?? User);

  const renderLink = (item: BackendNavigationItem, sub = false) => {
    const Icon = itemIcon(item);
    const active = item.href === activeHref;
    const text = label(item);
    if (sub) {
      return (
        <SidebarMenuSubItem key={item.href}>
          <SidebarMenuSubButton
            render={<Link href={item.href} onClick={onNavigate} aria-current={active ? 'page' : undefined} />}
            isActive={active}
            className="h-9 text-sm"
          >
            <span>{text}</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      );
    }
    return (
      <SidebarMenuItem key={item.href}>
        <SidebarMenuButton
          render={<Link href={item.href} onClick={onNavigate} aria-current={active ? 'page' : undefined} />}
          isActive={active}
          tooltip={text}
          className="h-9 gap-2.5 rounded-lg px-3 text-sm"
        >
          <Icon className="size-4" aria-hidden="true" />
          <span>{text}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  if (collapsed) {
    const all = [...items, ...groups.flatMap((group) => group.items)];
    return (
      <nav aria-label={ariaLabel} className="px-2">
        <SidebarMenu className="items-center gap-1">
          {all.map((item) => {
            const Icon = itemIcon(item);
            const active = item.href === activeHref;
            const text = label(item);
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  render={
                    <Link href={item.href} onClick={onNavigate} aria-current={active ? 'page' : undefined} />
                  }
                  isActive={active}
                  tooltip={text}
                  className="size-9 justify-center rounded-lg px-0"
                >
                  <Icon className="size-4" aria-hidden="true" />
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </nav>
    );
  }

  return (
    <nav aria-label={ariaLabel}>
      <SidebarMenu className="gap-2 px-2">
        {items.map((item) => renderLink(item))}
      </SidebarMenu>
      {groups.map((group) => {
        const open = openGroups[group.key] ?? group.defaultOpen;
        const GroupIcon = group.icon;
        return (
          <div key={group.key} className="mt-2">
            <SidebarMenu className="px-2">
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => setOpenGroups((current) => ({ ...current, [group.key]: !open }))}
                  aria-expanded={open}
                  tooltip={group.label}
                  className="h-9 gap-2.5 rounded-lg px-3 text-sm"
                >
                  <GroupIcon className="size-4" aria-hidden="true" />
                  <span>{group.label}</span>
                  <ChevronRight
                    className={cn(
                      'ml-auto size-4 text-sidebar-foreground/40 transition-transform duration-200',
                      open && 'rotate-90',
                    )}
                    aria-hidden="true"
                  />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <div
              className={cn(
                'grid transition-[grid-template-rows] duration-200 ease-out',
                open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
              )}
              aria-hidden={!open}
            >
              <div className="overflow-hidden">
                <SidebarMenuSub className="mt-0.5">
                  {group.items.map((item) => renderLink(item, true))}
                </SidebarMenuSub>
              </div>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

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
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const directItems = items.filter((item) => !item.group);
  const groups = groupBackendNavigation(items);

  const pathname = usePathname();
  const locale = useLocale();
  const t = useTranslator();
  const activeItem = resolveBackendActiveItem(pathname, items, rootHref);
  const activeHref = activeItem?.href ?? null;
  const label = (item: BackendNavigationItem): string => {
    if (isBackendOverview(item)) return t('adminShell.overview');
    const key = navMessageKey(item.href);
    return key ? t(key) : item.label;
  };
  const groupLabel = (group: string): string =>
    groupLabels?.[group] ??
    (GROUP_MESSAGE_KEYS[group] ? t(GROUP_MESSAGE_KEYS[group]) : group);
  const namedGroups = Array.from(groups.entries()).map(([group, groupItems]) => ({
    key: group,
    label: groupLabel(group),
    items: groupItems,
    defaultOpen: false,
    icon: groupIcons?.[group] ?? GROUP_ICONS[group] ?? Folder,
  }));
  const rootLabel =
    rootHref === '/admin' ? t('adminShell.backend') : t('nav.accountOverview');
  const activeGroup = activeItem?.group ? groupLabel(activeItem.group) : null;

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  return (
    <SidebarProvider
      open={!collapsed}
      onOpenChange={(open) => setCollapsed(!open)}
      className="contents"
    >
    <div className="backend-shell relative isolate flex h-dvh flex-col overflow-hidden bg-muted/40 text-foreground">
      <BackendRouteProgress />
      <NotificationToaster />

      <header className="backend-shell__header sticky top-0 z-50 flex h-14 shrink-0 items-center gap-1.5 px-3 sm:px-4">
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground md:hidden"
          aria-label={t('adminShell.openNav')}
        >
          <Menu className="size-4" aria-hidden="true" />
        </button>

        <Link
          href={rootHref}
          className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg"
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
          aria-label={t('adminShell.breadcrumb')}
          className="ml-1 flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
        >
          <Link href={rootHref} className="hidden shrink-0 transition-colors hover:text-foreground sm:inline">
            {rootLabel}
          </Link>
          {activeGroup ? (
            <>
              <span className="hidden text-muted-foreground/40 sm:inline" aria-hidden="true">
                /
              </span>
              <span className="hidden shrink-0 sm:inline">{activeGroup}</span>
            </>
          ) : null}
          <span className="hidden text-muted-foreground/40 sm:inline" aria-hidden="true">
            /
          </span>
          <span className="truncate font-medium text-foreground">
            {activeItem ? label(activeItem) : rootLabel}
          </span>
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
          <AgentSidebar
            open={agentOpen}
            onOpenChange={setAgentOpen}
            contextLabel={
              rootHref === '/admin'
                ? t('adminShell.workspaceAdmin')
                : t('adminShell.workspaceAccount')
            }
          />
          <div className="hidden sm:block">
            <Tooltip>
              <TooltipTrigger
                render={
                  <BackendToolbarButton
                    render={<Link href="/guide" aria-label={t('adminShell.help')} />}
                    nativeButton={false}
                  >
                    <HelpCircle aria-hidden="true" />
                  </BackendToolbarButton>
                }
              />
              <TooltipContent>{t('adminShell.help')}</TooltipContent>
            </Tooltip>
          </div>
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

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className={cn(
            'hidden h-full shrink-0 flex-col overflow-hidden bg-transparent transition-[width] duration-300 motion-reduce:transition-none md:flex',
            collapsed ? 'w-16' : 'w-[240px]',
          )}
        >
          <AnimateSidebar.Highlight animateOnHover className="flex-1 overflow-y-auto py-2">
            <SidebarNav
              items={directItems}
              groups={namedGroups}
              activeHref={activeHref}
              label={label}
              icons={navigationIcons}
              defaultIcon={defaultIcon}
              collapsed={collapsed}
              ariaLabel={t('adminShell.navLabel')}
            />
          </AnimateSidebar.Highlight>
          <div className="flex shrink-0 items-center justify-end p-3">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => setCollapsed((value) => !value)}
                    aria-label={collapsed ? t('adminShell.expandNav') : t('adminShell.collapseNav')}
                    className="flex size-8 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {collapsed ? (
                      <PanelLeftOpen className="size-4" aria-hidden="true" />
                    ) : (
                      <PanelLeftClose className="size-4" aria-hidden="true" />
                    )}
                  </button>
                }
              />
              <TooltipContent>
                {collapsed ? t('adminShell.expandNav') : t('adminShell.collapseNav')}
              </TooltipContent>
            </Tooltip>
          </div>
        </aside>


        <main className="min-h-0 min-w-0 flex-1 p-2 pl-0 md:p-3 md:pl-0">
          <div className="h-full overflow-y-auto rounded-[22px] bg-background px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
            <div
              key={pathname}
              className={cn(
                'mx-auto w-full animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out motion-reduce:animate-none',
                contentMaxWidth,
              )}
            >
              {children}
            </div>
          </div>
        </main>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[280px] bg-muted p-0">
          <SheetTitle className="sr-only">{t('adminShell.navLabel')}</SheetTitle>
          <div className="flex-1 overflow-y-auto py-3">
            <SidebarNav
              items={directItems}
              groups={namedGroups}
              activeHref={activeHref}
              label={label}
              icons={navigationIcons}
              defaultIcon={defaultIcon}
              collapsed={false}
              onNavigate={() => setMobileNavOpen(false)}
              ariaLabel={t('adminShell.navLabel')}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
    </SidebarProvider>
  );
}
