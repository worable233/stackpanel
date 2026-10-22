import { createElement } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, ClipboardList, Clock3, Headphones, Server, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@stackpanel/ui';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { AccountUser } from '@stackpanel/sdk';
import { getAuthedApiClient } from '@/lib/api';
import { executeAccountFinder, getPluginAccountWidgets } from '@/lib/account-frontend';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { FrontendScopeRoot } from '@/components/frontend-scope';

export const dynamic = 'force-dynamic';

interface ServiceItem {
  id: string;
  status?: string;
  expiresAt?: string | null;
}

interface CountSummary {
  count: number;
}

export default async function AccountHomePage() {
  const locale = await getLocale();
  const t = createTranslator(locale);
  const api = await getAuthedApiClient();
  const [userResult, widgets] = await Promise.all([
    api.getCurrentUser(),
    getPluginAccountWidgets(),
  ]);
  const user: AccountUser = {
    id: userResult.user.id,
    email: userResult.user.email,
    role: userResult.user.role,
  };
  const [ordersData, servicesData, ticketSummary, identities] = await Promise.all([
    executeAccountFinder('store.pendingOrderCount', user),
    executeAccountFinder('store.myServices', user),
    executeAccountFinder('ticket.pendingCount', user),
    api.getConnectedIdentities().catch(() => null),
  ]);
  const services = (servicesData as ServiceItem[] | null) ?? [];
  const now = currentTimestamp();
  const sevenDays = now + 7 * 24 * 60 * 60 * 1000;
  const pendingOrders = (ordersData as CountSummary | null)?.count;
  const activeServices = services.filter((service) => service.status === 'ACTIVE').length;
  const expiringServices = services.filter((service) => {
    if (!service.expiresAt || service.status === 'TERMINATED' || service.status === 'CANCELLED')
      return false;
    const expiresAt = Date.parse(service.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt >= now && expiresAt <= sevenDays;
  }).length;
  const pendingTickets = (ticketSummary as CountSummary | null)?.count;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('nav.dashboard')} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="break-all text-sm text-muted-foreground">
            {t('account.home.greeting', { email: user.email })}
          </p>
          <Badge variant="outline">
            {user.role === 'ADMIN' ? t('account.home.roleAdmin') : t('account.home.roleUser')}
          </Badge>
        </div>
        <Button render={<Link href="/shop" />}>{t('nav.shop')}</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {pendingOrders !== undefined ? (
          <SummaryCard
            title={t('account.home.pendingOrders')}
            value={pendingOrders}
            unit={t('account.home.unitOrders')}
            icon={<ClipboardList />}
            tone="text-primary"
            href="/account/orders"
            footer={t('account.home.allOrders')}
          />
        ) : null}
        {servicesData !== null ? (
          <SummaryCard
            title={t('account.home.running')}
            value={activeServices}
            unit={t('account.home.unitInstances')}
            icon={<Server />}
            tone="text-success"
            href="/account/services"
            footer={t('account.home.manageInstances')}
            secondary={{ label: t('account.home.newInstance'), href: '/shop' }}
          />
        ) : null}
        {servicesData !== null ? (
          <SummaryCard
            title={t('account.home.expiringSoon')}
            value={expiringServices}
            unit={t('account.home.unitInstances')}
            icon={<Clock3 />}
            tone="text-destructive"
            href="/account/services"
            footer={t('account.home.allProducts')}
          />
        ) : null}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {pendingTickets !== undefined ? (
          <SummaryCard
            title={t('account.home.pendingTickets')}
            value={pendingTickets}
            icon={<Headphones />}
            href="/account/tickets"
            footer={t('account.home.allTickets')}
            secondary={{ label: t('account.home.newTicket'), href: '/account/tickets/new' }}
          />
        ) : null}
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-success" />
              {t('account.home.securityTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <dt className="text-xs text-muted-foreground">{t('account.home.accountStatus')}</dt>
                <dd className="font-medium">
                  {userResult.user.status === 'ACTIVE'
                    ? t('account.home.statusActive')
                    : t('account.home.statusRestricted')}
                </dd>
              </div>
              <div className="flex flex-col gap-2">
                <dt className="text-xs text-muted-foreground">
                  {t('account.home.linkedIdentities')}
                </dt>
                <dd className="font-medium">
                  {identities
                    ? t('account.home.identityCount', { count: identities.identities.length })
                    : t('account.home.unavailable')}
                </dd>
              </div>
            </dl>
            <Link
              href="/account/settings#security"
              className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground hover:text-foreground"
            >
              {t('account.home.securityCenter')} <ArrowRight className="size-4" />
            </Link>
          </CardContent>
        </Card>
      </div>
      {widgets.length > 0 ? (
        <section className="grid gap-4 lg:grid-cols-2">
          {widgets.map((widget) => (
            <FrontendScopeRoot
              key={`${widget.pluginId}:${widget.id}`}
              scope={`plugins:${widget.pluginId}`}
              className="block h-full [&>a]:h-full"
            >
              {createElement(widget.component, {
                pluginId: widget.pluginId,
                user,
                settings: widget.settings,
                locale,
              })}
            </FrontendScopeRoot>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function currentTimestamp(): number {
  return Date.now();
}

function SummaryCard({
  title,
  value,
  unit,
  icon,
  tone = 'text-foreground',
  href,
  footer,
  secondary,
}: {
  title: string;
  value: number;
  unit?: string;
  icon: ReactNode;
  tone?: string;
  href: string;
  footer: string;
  secondary?: { label: string; href: string };
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className={`text-3xl font-semibold tabular-nums ${tone}`}>
          {value} {unit ? <span className="text-base text-foreground">{unit}</span> : null}
        </p>
        <div className="flex items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-4">
            <Link href={href} className="hover:text-foreground">
              {footer}
            </Link>
            {secondary ? (
              <Link href={secondary.href} className="border-l pl-4 hover:text-foreground">
                {secondary.label}
              </Link>
            ) : null}
          </div>
          <ArrowRight aria-hidden="true" className="size-4 shrink-0" />
        </div>
      </CardContent>
    </Card>
  );
}
