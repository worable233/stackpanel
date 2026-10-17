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

const amount = (value: number, currency = 'CNY') => {
  try {
    return formatMinorCurrency(value, currency, 'zh-CN');
  } catch {
    return `${value} ${currency}`;
  }
};
const monthLabel = (value: string) => `${Number(value.slice(0, 4))}年${Number(value.slice(5))}月`;
const entryLabels: Record<string, string> = {
  TOP_UP: '余额充值',
  ORDER_PAYMENT: '订单支付',
  ORDER_REFUND: '订单退款',
  ADMIN_ADJUST: '余额调整',
  llm_gateway_usage: 'API 用量消费',
  REFERRAL_REWARD: '推广奖励',
  REFERRAL_INVITEE_REWARD: '推广注册奖励',
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
  const data = props.data.overview as z.infer<typeof overviewSchema> | undefined;
  if (!data)
    return (
      <main className="flex flex-col gap-6">
        <PageHeader title="费用概览" />
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">费用数据暂时无法加载，请刷新重试。</p>
          </CardContent>
        </Card>
      </main>
    );
  const { account, monthly, entries } = data;
  const current = monthly.at(-1);
  const max = Math.max(...monthly.map((item) => item.amount), 1);
  const rows = [
    { label: '账户余额', value: amount(account.balance + account.held, account.currency) },
    { label: '冻结金额', value: amount(account.held, account.currency) },
    { label: '待支付金额', value: '以待支付订单为准' },
    { label: '未出账费用（预估）', value: '暂不支持' },
    { label: '赠金预计抵扣', value: '暂不支持' },
    { label: '待返还资金', value: '暂不支持' },
  ];
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        title="费用概览"
        actions={
          <Button render={<Link href="/account/balance" />}>
            <Plus data-icon="inline-start" />
            充值
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">可用额度</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="text-4xl font-semibold tracking-tight tabular-nums">
                {amount(account.balance)}
              </span>
              <span className="text-sm text-muted-foreground">{account.currency}</span>
            </p>
            <p className="text-xs text-muted-foreground">可直接用于云产品与服务消费</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">本月余额消费</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight tabular-nums">
                {amount(current?.amount ?? 0)}
              </span>
              <span className="text-sm text-muted-foreground">{account.currency}</span>
            </p>
            <Link href="#monthly-spending" className="w-fit text-xs text-primary hover:underline">
              查看月度消费 <span aria-hidden="true">↗</span>
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">赠金</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-3xl font-semibold text-muted-foreground">—</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Gift className="size-3.5" aria-hidden="true" />
              暂未提供赠金抵扣
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <details open className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-6 [&::-webkit-details-marker]:hidden">
            <SectionTitle icon={<Wallet />}>资金明细</SectionTitle>
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
                额度说明
              </p>
              <p className="text-sm leading-7 text-muted-foreground">
                可用额度为账户余额扣除冻结金额后的可支付余额。冻结资金将在结算后扣除实际费用，剩余部分退回可用额度。
              </p>
              <p className="text-xs leading-6 text-muted-foreground">
                消费统计仅包含余额扣款，不含外部支付、充值与人工调账；退款单独记录，不冲减消费金额。按北京时间自然月统计。
              </p>
              <Button variant="outline" size="sm" render={<Link href="/account/orders" />}>
                查看订单
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
              <SectionTitle icon={<ChartNoAxesColumn />}>月度消费</SectionTitle>
              <CardDescription>
                {monthly.length
                  ? `${monthLabel(monthly[0]!.month)} — ${monthLabel(current!.month)}`
                  : ''}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {monthly.some((item) => item.amount > 0) ? (
              <div className="flex flex-col gap-4">
                <p className="text-xs text-muted-foreground">余额消费 · CNY</p>
                <div
                  className="flex h-48 items-end gap-2 border-b pb-0 sm:gap-3"
                  role="img"
                  aria-label="最近十二个月余额消费柱状图"
                >
                  {monthly.map((item) => (
                    <div
                      key={item.month}
                      className="group/bar relative flex h-full min-w-0 flex-1 items-end justify-center"
                      title={`${monthLabel(item.month)}：${amount(item.amount)}`}
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
                      {Number(item.month.slice(5))}月
                    </span>
                  ))}
                </div>
                <table className="sr-only">
                  <caption>月度余额消费（CNY）</caption>
                  <tbody>
                    {monthly.map((item) => (
                      <tr key={item.month}>
                        <th>{monthLabel(item.month)}</th>
                        <td>{amount(item.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState kind="spending">暂无消费</EmptyState>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <SectionTitle icon={<ListFilter />}>最近资金变动</SectionTitle>
              <Link
                href="/account/balance/records#ledger"
                className="shrink-0 text-xs text-primary hover:underline"
              >
                余额流水 ↗
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
                        {entry.note ?? entryLabels[entry.type] ?? '余额变动'}
                      </p>
                      <time className="text-xs text-muted-foreground" dateTime={entry.createdAt}>
                        {new Date(entry.createdAt).toLocaleString('zh-CN', {
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
                      {amount(entry.amount)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        {entry.currency}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState kind="entries">暂无资金变动</EmptyState>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
