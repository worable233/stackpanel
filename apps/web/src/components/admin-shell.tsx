'use client';

import type { LucideIcon } from 'lucide-react';
import {
  ArrowUpCircle,
  Bell,
  Blocks,
  Box,
  LayoutDashboard,
  Palette,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react';
import {
  BackendShell,
  type BackendNavigationItem,
  type BackendUser,
} from '@/components/backend-shell';

const NAVIGATION_ICONS: Record<string, LucideIcon> = {
  '/admin': LayoutDashboard,
  '/admin/users': Users,
  '/admin/settings': Settings,
  '/admin/plugins': Blocks,
  '/admin/rbac': ShieldCheck,
  '/admin/payments': Wallet,
  '/admin/audit': ScrollText,
  '/admin/themes': Palette,
  '/admin/notifications': Bell,
  '/admin/updates': ArrowUpCircle,
};

export interface AdminShellProps {
  user: BackendUser;
  items: BackendNavigationItem[];
  children: React.ReactNode;
  brandLogoUrl?: string | null;
}

export function AdminShell({ user, items, children, brandLogoUrl }: AdminShellProps) {
  return (
    <BackendShell
      user={user}
      items={items}
      rootHref="/admin"
      navigationIcons={NAVIGATION_ICONS}
      defaultIcon={Box}
      contentMaxWidth="max-w-[1440px]"
      backLink={{ label: '', href: '/', messageKey: 'nav.backToSite' }}
      brandLogoUrl={brandLogoUrl}
    >
      {children}
    </BackendShell>
  );
}
