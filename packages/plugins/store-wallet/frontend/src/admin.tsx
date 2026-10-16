'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { FeatureOverview } from '@stackpanel/ui';
import type { ReactElement } from 'react';

interface WalletAccount {
  userId: string;
  email: string;
  balance: number;
  currency: string;
}

function FinanceOverview(props: AdminPageComponentProps): ReactElement {
  const result = props.data.wallets as { accounts: WalletAccount[] } | undefined;
  const accounts = result?.accounts ?? [];
  return (
    <FeatureOverview
      title="概览"
      description="查看钱包账户与资金分布。"
      unavailable={!result}
      metrics={[
        { label: '钱包账户', value: accounts.length },
        { label: '有余额账户', value: accounts.filter((account) => account.balance > 0).length },
        { label: '结算币种', value: new Set(accounts.map((account) => account.currency)).size },
      ]}
      links={[
        {
          label: '用户管理',
          description: '进入用户详情查看余额、资金流水或调整余额。',
          href: '/admin/users',
        },
      ]}
    />
  );
}

export const adminPages = {
  'admin/summary': FinanceOverview,
} as const;
