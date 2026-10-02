'use client';

import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  BrainCircuit,
  FileText,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Receipt,
  Server,
  ShieldCheck,
  ShoppingBag,
  Tags,
  Wallet,
} from 'lucide-react';
import {
  BackendShell,
  type BackendNavigationItem,
  type BackendUser,
} from '@/components/backend-shell';

const NAVIGATION_ICONS: Record<string, LucideIcon> = {
  '/account': LayoutDashboard,
  '/account/security': ShieldCheck,
  '/account/notifications': Bell,
  '/shop': ShoppingBag,
  '/account/services': Server,
  '/account/orders': Receipt,
  '/account/balance': Wallet,
  '/account/gateway': Gauge,
  '/account/gateway/pricing': Tags,
  '/account/gateway/keys': KeyRound,
};

const GROUP_ICONS: Record<string, LucideIcon> = {
  services: Server,
  models: BrainCircuit,
  billing: Wallet,
};

export interface AccountShellProps {
  user: BackendUser;
  items: BackendNavigationItem[];
  children: React.ReactNode;
  brandLogoUrl?: string | null;
}

export function AccountShell({ user, items, children, brandLogoUrl }: AccountShellProps) {
  return (
    <BackendShell
      user={user}
      items={items}
      rootHref="/account"
      navigationIcons={NAVIGATION_ICONS}
      defaultIcon={FileText}
      groupIcons={GROUP_ICONS}
      contentMaxWidth="max-w-6xl"
      backLink={{ label: '', href: '/', messageKey: 'nav.backToSite' }}
      brandLogoUrl={brandLogoUrl}
    >
      {children}
    </BackendShell>
  );
}
