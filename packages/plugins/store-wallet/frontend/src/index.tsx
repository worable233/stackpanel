import type {
  AccountPageComponentProps,
  AccountWidgetProps,
  FinderProvider,
  FrontendPackage,
} from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { Clock, Plus, Wallet } from 'lucide-react';

interface WalletEntry {
  id: string;
  amount: number;
  currency: string;
  type: string;
  note: string | null;
  createdAt: string;
}

interface WalletTopUp {
  id: string;
  amount: number;
  currency: string;
  providerId: string | null;
  paymentMethod: string | null;
  paymentUrl: string | null;
  status: string;
  createdAt: string;
}

const walletSchema = z.object({
  account: z.object({ balance: z.number(), currency: z.string() }),
  entries: z.array(
    z.object({
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      type: z.string(),
      note: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  topUps: z.array(
    z.object({
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      providerId: z.string().nullable(),
      paymentMethod: z.string().nullable(),
      paymentUrl: z.string().nullable(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      methods: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          topUpAmounts: z.array(z.number()).optional(),
        }),
      ),
    }),
  ),
});

const walletsSchema = z.object({
  accounts: z.array(
    z.object({ userId: z.string(), email: z.string(), balance: z.number(), currency: z.string() }),
  ),
});

const ICONS: Record<string, ReactElement> = {
  wallet: <Wallet />,
  plus: <Plus />,
  clock: <Clock />,
};

function Icon({ name }: { name: string }): ReactElement {
  return (
    <span
      className="inline-flex size-[1.15em] shrink-0 items-center justify-center leading-none [&_svg]:size-full"
      aria-hidden="true"
    >
      {ICONS[name]}
    </span>
  );
}

function money(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

function formatAmountInput(amount: number): string {
  return (amount / 100).toFixed(2);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}

function PriceTag({ amount, currency }: { amount: number; currency: string }): ReactElement {
  const [int, dec] = (amount / 100).toFixed(2).split('.');
  return (
    <span className="font-mono font-bold tracking-tight tabular-nums">
      <span className="align-super text-[0.65em] font-medium opacity-80">{currency} </span>
      <span>{int}</span>
      <span className="text-[0.75em] opacity-80">.{dec}</span>
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

function WalletAccountWidget(_props: AccountWidgetProps): ReactElement {
  return (
    <Link
      href="/account/balance"
      className="group block rounded-2xl border bg-card p-5 text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon name="wallet" />
      </span>
      <p className="mt-4 text-sm font-semibold">余额</p>
      <p className="mt-1.5 text-sm text-muted-foreground">管理余额、充值与人工调整。</p>
    </Link>
  );
}

function WalletAccountBalancePage(props: AccountPageComponentProps): ReactElement {
  const wallet = props.data.wallet as z.infer<typeof walletSchema> | undefined;
  const topUp = props.actions?.['wallet.create-topup'];
  const cancelTopUp = props.actions?.['wallet.cancel-topup'];
  const account = wallet?.account ?? { balance: 0, currency: 'CNY' };
  return (
    <main className="space-y-8">
      <PageHeader
        title="余额充值"
        description="充值、消费和人工调整都会记录在余额流水中。"
      />
      <section className="relative overflow-hidden rounded-2xl border bg-card p-6 shadow-sm">
        <div
          className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(22rem_10rem_at_0%_0%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
          aria-hidden="true"
        />
        <p className="relative text-sm text-muted-foreground">可用余额</p>
        <div className="relative mt-2 text-4xl">
          <PriceTag amount={account.balance} currency={account.currency} />
        </div>
      </section>
      <section className="space-y-4">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="flex size-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon name="plus" />
          </span>
          充值
        </h2>
        {wallet?.providers.length && topUp ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {wallet.providers.flatMap((provider) =>
              provider.methods.map((method) => (
                <section
                  key={`${provider.id}-${method.id}`}
                  className="rounded-2xl border bg-card p-5 shadow-sm"
                >
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <span className="flex size-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon name="wallet" />
                    </span>
                    {method.label}
                  </h3>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {(method.topUpAmounts ?? []).map((amount) => (
                      <form action={topUp} key={amount}>
                        <input type="hidden" name="providerId" value={provider.id} />
                        <input type="hidden" name="paymentMethod" value={method.id} />
                        <input type="hidden" name="amount" value={formatAmountInput(amount)} />
                        <button
                          type="submit"
                          className="h-9 rounded-lg border bg-background px-3.5 text-xs font-medium transition-colors hover:bg-muted"
                        >
                          {money(amount, 'CNY')}
                        </button>
                      </form>
                    ))}
                  </div>
                  <form action={topUp} className="mt-4 flex gap-2">
                    <input type="hidden" name="providerId" value={provider.id} />
                    <input type="hidden" name="paymentMethod" value={method.id} />
                    <input
                      name="amount"
                      type="text"
                      inputMode="decimal"
                      placeholder="自定义金额"
                      className="h-10 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm"
                    />
                    <button
                      type="submit"
                      className="h-10 rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                    >
                      充值
                    </button>
                  </form>
                </section>
              )),
            )}
          </div>
        ) : (
          <Empty text="暂未配置在线支付方式" />
        )}
      </section>
      <Ledger title="充值记录" rows={wallet?.topUps ?? []} cancel={cancelTopUp} />
      <Ledger title="余额流水" rows={wallet?.entries ?? []} />
    </main>
  );
}

function Ledger({
  title,
  rows,
  cancel,
}: {
  title: string;
  rows: Array<WalletTopUp | WalletEntry>;
  cancel?: ((formData: FormData) => Promise<void>) | undefined;
}): ReactElement {
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <span className="flex size-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon name="clock" />
        </span>
        {title}
      </h2>
      {rows.length ? (
        <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
              <div className="min-w-0">
                <p className="truncate">
                  {'type' in row
                    ? (row.note ?? row.type)
                    : `${row.providerId ?? '支付渠道'} · ${row.status}`}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(row.createdAt)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span
                  className={
                    'amount' in row && row.amount < 0
                      ? 'font-mono font-semibold text-destructive'
                      : 'font-mono font-semibold'
                  }
                >
                  {'type' in row
                    ? `${row.amount > 0 ? '+' : ''}${money(row.amount, row.currency)}`
                    : money(row.amount, row.currency)}
                </span>
                {'paymentUrl' in row && row.paymentUrl && row.status === 'PENDING' ? (
                  <a href={row.paymentUrl} className="text-primary hover:underline">
                    继续付款
                  </a>
                ) : null}
                {'paymentUrl' in row && cancel && ['PENDING', 'REVIEW'].includes(row.status) ? (
                  <form action={cancel}>
                    <input type="hidden" name="id" value={row.id} />
                    <button type="submit" className="text-muted-foreground hover:text-destructive">
                      取消
                    </button>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty text="暂无记录" />
      )}
    </section>
  );
}

const walletFinders: Record<string, FinderProvider> = {
  'wallet.me': {
    handler: async (_input, ctx) => ctx.api.get('/wallet', walletSchema),
  },
  'wallet.adminAccounts': {
    handler: async (_input, ctx) => ctx.api.get('/store/admin/wallets', walletsSchema),
  },
};

export const frontend: FrontendPackage = {
  finders: walletFinders,
  pages: [],
  pageComponents: {},
  ui: {
    actions: [
      {
        id: 'wallet.create-topup',
        method: 'POST',
        path: '/wallet/topups',
        permission: 'store.wallet',
        input: [
          { name: 'amount', type: 'money', required: true, min: 100, max: 2000000000 },
          { name: 'providerId', type: 'string', required: true, maxLength: 64 },
          { name: 'paymentMethod', type: 'string', required: true, maxLength: 64 },
        ],
        redirect: { responsePath: 'topUp.paymentUrl', external: true },
      },
      {
        id: 'wallet.cancel-topup',
        method: 'POST',
        path: '/wallet/topups/:id/cancel',
        permission: 'store.wallet',
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
      {
        id: 'wallet.adjust-wallet',
        method: 'POST',
        path: '/store/admin/wallets/adjustments',
        permission: 'store.admin',
        input: [
          { name: 'email', type: 'string', required: true, maxLength: 191 },
          { name: 'amount', type: 'integer', required: true, min: -2000000000, max: 2000000000 },
          { name: 'note', type: 'string', required: true, maxLength: 191 },
        ],
      },
    ],
    adminRoutes: [
      {
        path: '/wallets',
        component: 'admin/wallets',
        permission: 'store.admin',
        nav: { label: '钱包管理', group: '商店插件' },
        data: [{ finder: 'wallet.adminAccounts', as: 'wallets' }],
      },
    ],
    accountWidgets: [
      {
        id: 'wallet-balance',
        title: '余额',
        component: 'account/balance',
        permission: 'store.wallet',
      },
    ],
    accountRoutes: [
      {
        path: '/balance',
        component: 'account/balance',
        permission: 'store.wallet',
        nav: { label: '余额充值', group: '费用' },
        data: [{ finder: 'wallet.me', as: 'wallet' }],
      },
    ],
    accountWidgetComponents: { 'account/balance': WalletAccountWidget },
    accountPages: { 'account/balance': WalletAccountBalancePage },
  },
};

export default frontend;