import { createElement } from 'react';
import type { AccountUser } from '@stackpanel/sdk';
import { getAuthedApiClient } from '@/lib/api';
import { executeAccountFinder, getPluginAccountWidgets } from '@/lib/account-frontend';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

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
    <main className="space-y-6">
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-col gap-6 p-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-lg font-medium text-card-foreground">
                {t('account.home.greeting', { email: user.email })}
              </p>
              <span
                className={`inline-flex w-fit shrink-0 items-center justify-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
                  user.role === 'ADMIN'
                    ? 'bg-teal-500/10 text-teal-500'
                    : 'bg-primary/10 text-primary'
                }`}
              >
                {user.role === 'ADMIN' ? t('account.home.roleAdmin') : t('account.home.roleUser')}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-6">
            {typeof balance === 'number' ? (
              <>
                <div>
                  <p className="text-xs text-muted-foreground">{t('account.home.balance')}</p>
                  <p className="mt-1 text-2xl font-medium text-card-foreground tabular-nums">
                    {(balance / 100).toFixed(2)} {currency}
                  </p>
                </div>
                <div className="h-12 w-px shrink-0 bg-border" aria-hidden="true" />
              </>
            ) : null}
            {orders.length > 0 ? (
              <>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('account.home.activeServices')}
                  </p>
                  <p className="mt-1 text-2xl font-medium text-card-foreground">{activeServices}</p>
                </div>
                <div className="h-12 w-px shrink-0 bg-border" aria-hidden="true" />
              </>
            ) : null}
            <div>
              <p className="text-xs text-muted-foreground">{t('account.home.security')}</p>
              <p className="mt-1 text-2xl font-medium text-card-foreground">
                {t('account.home.protected')}
              </p>
            </div>
          </div>
        </div>
      </section>
      {widgets.length > 0 ? (
        <section className="grid gap-4 lg:grid-cols-2">
          {widgets.map((widget) =>
            createElement(widget.component, {
              key: `${widget.pluginId}:${widget.id}`,
              pluginId: widget.pluginId,
              user,
              settings: widget.settings,
            }),
          )}
        </section>
      ) : null}
    </main>
  );
}
