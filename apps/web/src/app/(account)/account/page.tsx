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
  const t = createTranslator(await getLocale());
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
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {pendingOrders !== undefined ? (
          <SummaryCard
            title="待付订单"
            value={pendingOrders}
            unit="条"
            icon={<ClipboardList />}
            tone="text-primary"
            href="/account/orders"
            footer="全部订单"
          />
        ) : null}
        {servicesData !== null ? (
          <SummaryCard
            title="正在运行"
            value={activeServices}
            unit="台"
            icon={<Server />}
            tone="text-success"
            href="/account/services"
            footer="管理实例"
            secondary={{ label: '新建实例', href: '/shop' }}
          />
        ) : null}
        {servicesData !== null ? (
          <SummaryCard
            title="7 天内到期"
            value={expiringServices}
            unit="台"
            icon={<Clock3 />}
            tone="text-destructive"
            href="/account/services"
            footer="全部产品"
          />
        ) : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {pendingTickets !== undefined ? (
          <SummaryCard
            title="待处理工单"
            value={pendingTickets}
            icon={<Headphones />}
            href="/account/tickets"
            footer="全部工单"
            secondary={{ label: '提交工单', href: '/account/tickets/new' }}
          />
        ) : null}
        <Card className="min-h-52">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck className="size-5 text-success" />
              账户安全
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-6">
            <dl className="grid flex-1 grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <dt className="text-sm text-muted-foreground">账户状态</dt>
                <dd className="font-medium">
                  {userResult.user.status === 'ACTIVE' ? '正常' : '受限'}
                </dd>
              </div>
              <div className="flex flex-col gap-2">
                <dt className="text-sm text-muted-foreground">已绑定身份</dt>
                <dd className="font-medium">
                  {identities ? `${identities.identities.length} 个` : '暂不可用'}
                </dd>
              </div>
            </dl>
            <Link
              href="/account/settings#security"
              className="flex items-center justify-between border-t pt-4 text-sm text-muted-foreground hover:text-foreground"
            >
              安全中心 <ArrowRight className="size-4" />
            </Link>
          </CardContent>
        </Card>
      </div>
      {widgets.length > 0 ? (
        <section className="grid gap-4 lg:grid-cols-2">
          {widgets.map((widget) => (
            <div key={`${widget.pluginId}:${widget.id}`} className="h-full [&>a]:h-full">
              {createElement(widget.component, {
                pluginId: widget.pluginId,
                user,
                settings: widget.settings,
              })}
            </div>
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
    <Card className="min-h-52">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <span className="text-muted-foreground [&_svg]:size-5">{icon}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-6">
        <p className={`text-5xl font-semibold tabular-nums ${tone}`}>
          {value} {unit ? <span className="text-xl text-foreground">{unit}</span> : null}
        </p>
        <div className="flex items-center justify-between gap-3 border-t pt-4 text-sm text-muted-foreground">
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
