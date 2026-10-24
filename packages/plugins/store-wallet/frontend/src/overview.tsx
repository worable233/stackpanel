import type { AccountPageComponentProps } from '@stackpanel/sdk';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardDescription,
  PageHeader,
  SectionTitle,
} from '@stackpanel/ui';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChartNoAxesColumn,
  ChevronDown,
  CircleHelp,
  Gift,
  ListFilter,
  Plus,
  ReceiptText,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { z } from 'zod';
import { formatMinorCurrency } from '@stackpanel/sdk';
import { t } from './i18n.js';

export const overviewSchema = z.object({
  account: z.object({
    balance: z.number(),
    held: z.number().optional().default(0),
    currency: z.string(),
  }),
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
  monthly: z.array(z.object({ month: z.string(), amount: z.number() })),
});

const amount = (value: number, currency = 'CNY', locale?: string) => {
  try {
    return formatMinorCurrency(value, currency, locale);
  } catch {
    return `${value} ${currency}`;
  }
};

/**
 * Month label for a `YYYY-MM` bucket.
 *
 * Uses `Intl.DateTimeFormat` rather than hand-built "YYYY年M月" copy so the
 * format follows the requested locale (ADR-0016 §4). Buckets are calendar
 * months in Beijing time, matching the backend's aggregation.
 */
const monthLabel = (value: string, locale?: string) =>
  new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(`${value}-01T00:00:00+08:00`));

/** Ledger entry type → message id. Types are API values, not display copy. */
const ENTRY_KEYS: Record<string, string> = {
  TOP_UP: 'entry.TOP_UP',
  ORDER_PAYMENT: 'entry.ORDER_PAYMENT',
  ORDER_REFUND: 'entry.ORDER_REFUND',
  ADMIN_ADJUST: 'entry.ADMIN_ADJUST',
  llm_gateway_usage: 'entry.llm_gateway_usage',
  REFERRAL_REWARD: 'entry.REFERRAL_REWARD',
  REFERRAL_INVITEE_REWARD: 'entry.REFERRAL_INVITEE_REWARD',
};

function EmptyState({
  kind,
  children,
}: {
  kind: 'spending' | 'entries';
  children: React.ReactNode;
}) {
  const Icon = kind === 'spending' ? ChartNoAxesColumn : ReceiptText;
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-muted-foreground">
      <Icon className="size-5 opacity-50" aria-hidden="true" />
      <p className="text-sm">{children}</p>
    </div>
  );
}

export function WalletOverviewPage(props: AccountPageComponentProps) {
  const tr = t(props.locale);
  const data = props.data.overview as z.infer<typeof overviewSchema> | undefined;
  if (!data)
    return (
      <main className="flex flex-col gap-6">
        <PageHeader title={tr('overview.title')} />
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">{tr('overview.unavailable')}</p>
          </CardContent>
        </Card>
      </main>
    );
  const { account, monthly, entries } = data;
  const current = monthly.at(-1);
  const max = Math.max(...monthly.map((item) => item.amount), 1);
  const notSupported = tr('overview.notSupported');
  const rows = [
    {
      label: tr('overview.rowBalance'),
      value: amount(account.balance + account.held, account.currency, props.locale),
    },
    {
      label: tr('overview.rowHeld'),
      value: amount(account.held, account.currency, props.locale),
    },
    { label: tr('overview.rowOutstanding'), value: tr('overview.rowOutstandingValue') },
    { label: tr('overview.rowUnbilled'), value: notSupported },
    { label: tr('overview.rowGrantOffset'), value: notSupported },
    { label: tr('overview.rowRefundable'), value: notSupported },
  ];
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        title={tr('overview.title')}
        actions={
          <Button nativeButton={false} render={<Link href="/account/balance" />}>
            <Plus data-icon="inline-start" />
            {tr('overview.topUp')}
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">{tr('overview.availableCredit')}</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="text-4xl font-semibold tracking-tight tabular-nums">
                {amount(account.balance, account.currency, props.locale)}
              </span>
              <span className="text-sm text-muted-foreground">{account.currency}</span>
            </p>
            <p className="text-xs text-muted-foreground">{tr('overview.availableCreditHint')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">{tr('overview.monthSpend')}</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight tabular-nums">
                {amount(current?.amount ?? 0, account.currency, props.locale)}
              </span>
              <span className="text-sm text-muted-foreground">{account.currency}</span>
            </p>
            <Link href="#monthly-spending" className="w-fit text-xs text-primary hover:underline">
              {tr('overview.viewMonthly')} <span aria-hidden="true">↗</span>
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">{tr('overview.grant')}</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-3xl font-semibold text-muted-foreground">—</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Gift className="size-3.5" aria-hidden="true" />
              {tr('overview.grantUnavailable')}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <details open className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-6 [&::-webkit-details-marker]:hidden">
            <SectionTitle icon={<Wallet />}>{tr('overview.ledgerTitle')}</SectionTitle>
            <ChevronDown
              className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <CardContent className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <dl className="flex flex-col divide-y">
              {rows.map((row) => (
                <div
                  key={row.label}
                  className="flex items-center justify-between gap-4 py-3.5 first:pt-0 last:pb-0"
                >
                  <dt className="text-sm text-muted-foreground">{row.label}</dt>
                  <dd className="text-right text-sm tabular-nums">{row.value}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-col items-start gap-4 lg:border-l lg:pl-8">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CircleHelp className="size-4 text-muted-foreground" />
                {tr('overview.creditNote')}
              </p>
              <p className="text-sm leading-7 text-muted-foreground">
                {tr('overview.creditNoteBody')}
              </p>
              <p className="text-xs leading-6 text-muted-foreground">
                {tr('overview.statsNote')}
              </p>
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link href="/account/orders" />}
              >
                {tr('overview.viewOrders')}
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
          </CardContent>
        </details>
      </Card>

      <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card id="monthly-spending" className="scroll-mt-24">
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <SectionTitle icon={<ChartNoAxesColumn />}>{tr('overview.monthlyTitle')}</SectionTitle>
              <CardDescription>
                {monthly.length
                  ? `${monthLabel(monthly[0]!.month, props.locale)} — ${monthLabel(current!.month, props.locale)}`
                  : ''}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {monthly.some((item) => item.amount > 0) ? (
              <div className="flex flex-col gap-4">
                <p className="text-xs text-muted-foreground">{tr('overview.monthlySubtitle')}</p>
                <div
                  className="flex h-48 items-end gap-2 border-b pb-0 sm:gap-3"
                  role="img"
                  aria-label={tr('overview.monthlyAria')}
                >
                  {monthly.map((item) => (
                    <div
                      key={item.month}
                      className="group/bar relative flex h-full min-w-0 flex-1 items-end justify-center"
                      title={tr('overview.monthlyTooltip', {
                        month: monthLabel(item.month, props.locale),
                        amount: amount(item.amount, account.currency, props.locale),
                      })}
                    >
                      <div
                        className="w-full max-w-8 rounded-t bg-primary/75 transition-colors hover:bg-primary"
                        style={{
                          height: `${item.amount > 0 ? Math.max(2, (item.amount / max) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 sm:gap-3" aria-hidden="true">
                  {monthly.map((item) => (
                    <span
                      key={item.month}
                      className="min-w-0 flex-1 text-center text-xs text-muted-foreground"
                    >
                      {tr('overview.monthShort', { month: Number(item.month.slice(5)) })}
                    </span>
                  ))}
                </div>
                <table className="sr-only">
                  <caption>{tr('overview.monthlyCaption')}</caption>
                  <tbody>
                    {monthly.map((item) => (
                      <tr key={item.month}>
                        <th>{monthLabel(item.month, props.locale)}</th>
                        <td>{amount(item.amount, account.currency, props.locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState kind="spending">{tr('overview.emptySpending')}</EmptyState>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <SectionTitle icon={<ListFilter />}>{tr('overview.recentTitle')}</SectionTitle>
              <Link
                href="/account/balance/records#ledger"
                className="shrink-0 text-xs text-primary hover:underline"
              >
                {tr('overview.ledgerLink')} ↗
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {entries.length ? (
              <ul className="flex flex-col divide-y">
                {entries.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center gap-3 py-3.5 first:pt-0 last:pb-0"
                  >
                    {entry.amount >= 0 ? (
                      <ArrowDownLeft className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <p className="truncate text-sm" title={entry.note ?? undefined}>
                        {entry.note ??
                          (ENTRY_KEYS[entry.type] ? tr(ENTRY_KEYS[entry.type]!) : tr('entry.fallback'))}
                      </p>
                      <time className="text-xs text-muted-foreground" dateTime={entry.createdAt}>
                        {new Date(entry.createdAt).toLocaleString(props.locale, {
                          timeZone: 'Asia/Shanghai',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        })}
                      </time>
                    </div>
                    <p className="shrink-0 text-right text-sm font-medium tabular-nums">
                      {entry.amount > 0 ? '+' : ''}
                      {amount(entry.amount, entry.currency, props.locale)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        {entry.currency}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState kind="entries">{tr('overview.emptyEntries')}</EmptyState>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
