'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import type { ReactElement } from 'react';
import { Wallet } from 'lucide-react';

interface WalletAccount {
  userId: string;
  email: string;
  balance: number;
  currency: string;
}

function money(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

function Icon({ name }: { name: string }): ReactElement {
  return (
    <span
      className="inline-flex size-[1.15em] shrink-0 items-center justify-center leading-none [&_svg]:size-full"
      aria-hidden="true"
    >
      {name === 'wallet' ? <Wallet /> : null}
    </span>
  );
}

function Empty({ text }: { text: string }): ReactElement {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Icon name="wallet" />
      </span>
      <p className="mt-4 text-sm font-medium">{text}</p>
    </div>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required = false,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
}): ReactElement {
  return (
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        className="h-10 rounded-lg border bg-background px-3"
      />
    </label>
  );
}

function AdminTable({
  title,
  headers,
  rows,
}: {
  title: string;
  headers: string[];
  rows: string[][];
}): ReactElement {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {rows.length ? (
        <div className="overflow-x-auto rounded-2xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                {headers.map((header) => (
                  <th key={header} className="px-4 py-2.5 font-medium">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${title}-${index}`} className="border-b last:border-0">
                  {row.map((cell) => (
                    <td key={cell} className="px-4 py-2.5">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty text="暂无数据" />
      )}
    </section>
  );
}

export function WalletAdminPage(props: AdminPageComponentProps): ReactElement {
  const accounts = (props.data.wallets as { accounts?: WalletAccount[] } | undefined)?.accounts ?? [];
  const adjust = props.actions?.['wallet.adjust-wallet'];
  return (
    <main className="w-full space-y-8">
      <PageHeader title="钱包管理" description="查看用户余额并进行人工调整。" />
      {adjust ? (
        <form
          action={adjust}
          className="grid gap-3 rounded-2xl border bg-card p-5 shadow-sm sm:grid-cols-3"
        >
          <Field label="用户邮箱" name="email" type="email" required />
          <Field label="调整金额（分，可为负数）" name="amount" type="number" required />
          <Field label="说明" name="note" required />
          <button
            type="submit"
            className="h-10 w-fit rounded-xl border bg-background px-4 text-sm font-semibold hover:bg-muted sm:col-span-3"
          >
            调整余额
          </button>
        </form>
      ) : null}
      <AdminTable
        title="用户余额"
        headers={['用户', '余额']}
        rows={accounts.map((account) => [account.email, money(account.balance, account.currency)])}
      />
    </main>
  );
}

export const adminPages = {
  'admin/wallets': WalletAdminPage,
} as const;
