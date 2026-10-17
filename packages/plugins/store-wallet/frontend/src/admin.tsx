'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { FeatureOverview } from '@stackpanel/ui';
import type { ReactElement } from 'react';
import { t } from './i18n.js';

interface WalletAccount {
  userId: string;
  email: string;
  balance: number;
  currency: string;
}

function FinanceOverview(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const result = props.data.wallets as { accounts: WalletAccount[] } | undefined;
  const accounts = result?.accounts ?? [];
  return (
    <FeatureOverview
      title={tr('admin.title')}
      description={tr('admin.description')}
      unavailable={!result}
      labels={{
        unavailable: tr('admin.unavailable'),
        manageTitle: tr('admin.manageTitle'),
        manageDescription: tr('admin.manageDescription'),
        activityDescription: tr('admin.activityDescription'),
        empty: tr('admin.empty'),
      }}
      metrics={[
        { label: tr('admin.metricAccounts'), value: accounts.length },
        {
          label: tr('admin.metricWithBalance'),
          value: accounts.filter((account) => account.balance > 0).length,
        },
        {
          label: tr('admin.metricCurrencies'),
          value: new Set(accounts.map((account) => account.currency)).size,
        },
      ]}
      links={[
        {
          label: tr('admin.linkUsers'),
          description: tr('admin.linkUsersDescription'),
          href: '/admin/users',
        },
      ]}
    />
  );
}

export const adminPages = {
  'admin/summary': FinanceOverview,
} as const;
