import { createElement } from 'react';
import { ShieldCheck, Wallet, Server } from 'lucide-react';
import { Reveal } from '@stackpanel/ui';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { AccountUser } from '@stackpanel/sdk';
import { getAuthedApiClient } from '@/lib/api';
import { executeAccountFinder, getPluginAccountWidgets } from '@/lib/account-frontend';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { FrontendScopeRoot } from '@/components/frontend-scope';

export const dynamic = 'force-dynamic';

interface WalletData {
  account?: { balance?: number; currency?: string };
}

interface OrderItem {
  id: string;
  total?: number;
  currency?: string;
  status?: string;
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
  const [wallet, ordersData] = await Promise.all([
    executeAccountFinder('store.wallet', user),
    executeAccountFinder('store.myOrders', user),
  ]);
  const balance = (wallet as WalletData | null)?.account?.balance;
  const currency = (wallet as WalletData | null)?.account?.currency ?? 'CNY';
  const orders = (ordersData as OrderItem[] | null) ?? [];
  const activeServices = orders.filter(
    (order) => order.status === 'COMPLETED' || order.status === 'PAID',
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <Reveal>
        <h1 className="text-2xl font-medium tracking-tight">{t('nav.dashboard')}</h1>
      </Reveal>
      <Reveal>
        <Card className="relative overflow-hidden">
          <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-32 size-80 rounded-full bg-primary/10 blur-3xl" />
          <CardHeader className="relative gap-3 pb-6 sm:p-8">
            <div className="flex flex-wrap items-center gap-3">
              <CardTitle className="min-w-0 break-all leading-relaxed">
                {t('account.home.greeting', { email: user.email })}
              </CardTitle>
              <Badge variant="secondary">
                {user.role === 'ADMIN' ? t('account.home.roleAdmin') : t('account.home.roleUser')}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="relative grid gap-6 sm:grid-cols-3 sm:px-8 sm:pb-8">
            {typeof balance === 'number' ? (
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Wallet className="size-5" /></span>
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">{t('account.home.balance')}</p>
                  <p className="mt-1 text-2xl font-medium tabular-nums">{(balance / 100).toFixed(2)} <span className="text-sm text-muted-foreground">{currency}</span></p>
                </div>
              </div>
            ) : null}
            {orders.length > 0 ? (
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Server className="size-5" /></span>
                <div>
                  <p className="text-sm text-muted-foreground">{t('account.home.activeServices')}</p>
                  <p className="mt-1 text-2xl font-medium tabular-nums">{activeServices}</p>
                </div>
              </div>
            ) : null}
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success"><ShieldCheck className="size-5" /></span>
              <div>
                <p className="text-sm text-muted-foreground">{t('account.home.security')}</p>
                <p className="mt-1 text-xl font-medium">{t('account.home.protected')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </Reveal>
      {widgets.length > 0 ? (
        <section className="grid gap-4 lg:grid-cols-2">
          {widgets.map((widget) => (
            <Reveal key={`${widget.pluginId}:${widget.id}`} className="h-full [&>a]:h-full">
              <FrontendScopeRoot
                scope={`plugins:${widget.pluginId}`}
                className="block h-full"
              >
                {createElement(widget.component, {
                  pluginId: widget.pluginId,
                  user,
                  settings: widget.settings,
                })}
              </FrontendScopeRoot>
            </Reveal>
          ))}
        </section>
      ) : null}
    </div>
  );
}
