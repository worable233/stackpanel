import type {
  AccountPageComponentProps,
  AccountWidgetProps,
  FinderProvider,
  FrontendPackage,
} from '@stackpanel/sdk';
import {
  Button,
  Card,
  CardContent,
  PageHeader,
  SectionTitle,
  WalletRecharge,
} from '@stackpanel/ui';
import { formatMinorCurrency } from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { ArrowLeft, Clock, Plus, Wallet } from 'lucide-react';
import { overviewSchema, WalletOverviewPage } from './overview';
import { messages, t } from './i18n.js';

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

function money(amount: number, currency: string, locale?: string): string {
  // Wallet balances are minor units; render through the catalog so a future
  // non-CNY wallet cannot silently divide by 100.
  try {
    return formatMinorCurrency(amount, currency, locale);
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatDate(value: string, locale?: string): string {
  return new Date(value).toLocaleString(locale);
}

function Empty({ text }: { text: string }): ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-16 text-center text-muted-foreground">
      <span className="size-5 opacity-50">
        <Icon name="wallet" />
      </span>
      <p className="text-sm">{text}</p>
    </div>
  );
}

function WalletAccountWidget(props: AccountWidgetProps): ReactElement {
  const tr = t(props.locale);
  return (
    <Link
      href="/account/balance"
      className="group block rounded-2xl border bg-card p-5 text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon name="wallet" />
      </span>
      <p className="mt-4 text-sm font-semibold">{tr('widget.title')}</p>
      <p className="mt-1.5 text-sm text-muted-foreground">{tr('widget.description')}</p>
    </Link>
  );
}

function WalletAccountBalancePage(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const wallet = props.data.wallet as z.infer<typeof walletSchema> | undefined;
  return (
    <main className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label={tr('balance.back')}
          render={<Link href="/account/billing" />}
        >
          <ArrowLeft />
        </Button>
        <PageHeader title={tr('balance.title')} />
      </div>
      <Card className="max-w-5xl">
        <CardContent>
          {wallet ? (
            <WalletRecharge
              methods={wallet.providers.flatMap((provider) =>
                provider.methods.map((method) => ({
                  providerId: provider.id,
                  providerName: provider.name,
                  id: method.id,
                  label: method.label,
                  amounts: method.topUpAmounts,
                })),
              )}
              action={props.actions?.['wallet.create-topup']}
              currency={wallet.account.currency}
              labels={{
                amountLabel: tr('recharge.amountLabel'),
                presetsAria: tr('recharge.presetsAria'),
                paymentMethod: tr('recharge.paymentMethod'),
                noMethods: tr('recharge.noMethods'),
                submitting: tr('recharge.submitting'),
                submit: tr('recharge.submit'),
              }}
              cancelLink={
                <Button variant="ghost" render={<Link href="/account/billing" />}>
                  {tr('balance.cancel')}
                </Button>
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">{tr('balance.unavailable')}</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function WalletAccountRecordsPage(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const wallet = props.data.wallet as z.infer<typeof walletSchema> | undefined;
  return (
    <main className="flex flex-col gap-6">
      <PageHeader title={tr('records.title')} />
      {wallet ? (
        <>
          <Ledger
            title={tr('records.topups')}
            titleKey="records.topups"
            rows={wallet.topUps}
            cancel={props.actions?.['wallet.cancel-topup']}
            tr={tr}
            locale={props.locale}
          />
          <Ledger
            title={tr('records.ledger')}
            titleKey="records.ledger"
            rows={wallet.entries}
            tr={tr}
            locale={props.locale}
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{tr('records.unavailable')}</p>
      )}
    </main>
  );
}

function Ledger({
  title,
  titleKey,
  rows,
  cancel,
  tr,
  locale,
}: {
  title: string;
  /** Stable id used for the `#ledger` anchor, independent of the display language. */
  titleKey: 'records.topups' | 'records.ledger';
  rows: Array<WalletTopUp | WalletEntry>;
  cancel?: ((formData: FormData) => Promise<void>) | undefined;
  tr: ReturnType<typeof t>;
  locale?: string;
}): ReactElement {
  return (
    <section id={titleKey === 'records.ledger' ? 'ledger' : undefined} className="scroll-mt-24">
      <SectionTitle icon={<Clock />} className="mb-3">
        {title}
      </SectionTitle>
      {rows.length ? (
        <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate">
                  {'type' in row
                    ? (row.note ?? row.type)
                    : `${row.providerId ?? tr('records.provider')} · ${row.status}`}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatDate(row.createdAt, locale)}
                </p>
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
                    ? `${row.amount > 0 ? '+' : ''}${money(row.amount, row.currency, locale)}`
                    : money(row.amount, row.currency, locale)}
                </span>
                {'paymentUrl' in row && row.paymentUrl && row.status === 'PENDING' ? (
                  <a href={row.paymentUrl} className="text-primary hover:underline">
                    {tr('records.continuePayment')}
                  </a>
                ) : null}
                {'paymentUrl' in row && cancel && ['PENDING', 'REVIEW'].includes(row.status) ? (
                  <form action={cancel}>
                    <input type="hidden" name="id" value={row.id} />
                    <button type="submit" className="text-muted-foreground hover:text-destructive">
                      {tr('records.cancel')}
                    </button>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty text={tr('records.empty')} />
      )}
    </section>
  );
}

const walletFinders: Record<string, FinderProvider> = {
  'wallet.overview': {
    handler: async (_input, ctx) => ctx.api.get('/wallet/overview', overviewSchema),
  },
  'wallet.me': {
    handler: async (_input, ctx) => ctx.api.get('/wallet', walletSchema),
  },
  'wallet.adminAccounts': {
    handler: async (_input, ctx) => ctx.api.get('/store/admin/wallets', walletsSchema),
  },
};

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'en-US'],
  messages,
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
    ],
    adminRoutes: [
      {
        path: '/overview',
        component: 'admin/summary',
        permission: 'store.admin',
        nav: {
          labelKey: 'nav.overview',
          groupKey: 'nav.groupFinance',
          order: 0,
        },
        data: [{ finder: 'wallet.adminAccounts', as: 'wallets' }],
      },
    ],
    accountWidgets: [
      {
        id: 'wallet-balance',
        titleKey: 'widget.title',
        component: 'account/balance',
        permission: 'store.wallet',
      },
    ],
    accountRoutes: [
      {
        path: '/billing',
        component: 'account/overview',
        permission: 'store.wallet',
        nav: {
          labelKey: 'nav.overview',
          groupKey: 'nav.groupBilling',
          order: 0,
          activePaths: ['/balance'],
        },
        data: [{ finder: 'wallet.overview', as: 'overview' }],
      },
      {
        path: '/balance',
        component: 'account/balance',
        permission: 'store.wallet',
        data: [{ finder: 'wallet.me', as: 'wallet' }],
      },
      {
        path: '/balance/records',
        component: 'account/records',
        permission: 'store.wallet',
        data: [{ finder: 'wallet.me', as: 'wallet' }],
      },
    ],
    accountWidgetComponents: { 'account/balance': WalletAccountWidget },
    accountPages: {
      'account/balance': WalletAccountBalancePage,
      'account/overview': WalletOverviewPage,
      'account/records': WalletAccountRecordsPage,
    },
  },
};

export default frontend;
