import type { AccountPageComponentProps, FinderProvider, FrontendPackage } from '@stackpanel/sdk';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  PageHeader,
  SectionTitle,
  StatusBadge,
  type StatusTone,
} from '@stackpanel/ui';
import { formatMinorCurrency } from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import { Gift, Link2, Share2 } from 'lucide-react';
import { adminConfigSchema, adminListSchema, mineSchema } from './schemas';
import { CopyLinkButton } from './route-progress.js';

const TRIGGER_LABELS: Record<string, string> = {
  register: '注册即发',
  first_order: '首单后发',
  register_frozen: '冻结后发',
};

const INVITER_STATE: Record<string, { label: string; tone: StatusTone }> = {
  pending: { label: '待发放', tone: 'warn' },
  paid: { label: '已发放', tone: 'ok' },
  rejected: { label: '已拒绝', tone: 'error' },
};

function money(amount: number, currency: string): string {
  // Reward balances are minor units; respect the currency's precision instead
  // of assuming two decimals.
  try {
    return formatMinorCurrency(amount, currency, 'zh-CN');
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}

function Empty({ text }: { text: string }): ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-12 text-center text-muted-foreground">
      <Share2 className="size-5 opacity-50" aria-hidden="true" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

function ReferralAccountPage(props: AccountPageComponentProps): ReactElement {
  const referral = props.data.referral as ReturnType<typeof mineSchema.parse> | undefined;
  const createCode = props.actions?.['referral.create-code'];
  const toggleCode = props.actions?.['referral.toggle-code'];

  if (!referral) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader title="我的推广" />
        <p className="text-sm text-muted-foreground">推广数据暂时无法加载，请刷新重试。</p>
      </main>
    );
  }

  const { config, codes, invites, stats } = referral;
  const currency = config.currency;
  const triggerLabel = TRIGGER_LABELS[config.trigger] ?? config.trigger;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader title="我的推广" />

      {!config.enabled ? (
        <p
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-300"
        >
          推广功能当前已关闭，新建的链接暂不会产生奖励。
        </p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="累计邀请"
          value={String(stats.totalInvites)}
          hint={`归因有效期 ${config.cookieDays} 天`}
        />
        <StatCard
          label="已发放邀请"
          value={String(stats.paidInvites)}
          hint={`发奖时点：${triggerLabel}`}
        />
        <StatCard
          label="累计奖励"
          value={money(stats.earnedAmount, currency)}
          hint="已发放到余额"
        />
        <StatCard label="当前余额" value={money(stats.balance, currency)} />
      </section>

      <Card>
        <CardHeader>
          <SectionTitle icon={<Gift />}>奖励规则</SectionTitle>
          <CardDescription>
            每成功邀请一位新用户，你可得 {money(config.rewardAmount, currency)}； 被邀请人可得{' '}
            {money(config.inviteeRewardAmount, currency)}。
          </CardDescription>
        </CardHeader>
      </Card>

      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Link2 />}>我的推广码</SectionTitle>

        <Card>
          <CardContent className="pt-6">
            {createCode ? (
              <form action={createCode} className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="referral-label">渠道备注</Label>
                  <Input
                    id="referral-label"
                    name="label"
                    maxLength={40}
                    placeholder="例如：微博、给朋友的链接"
                  />
                </div>
                <div className="flex w-full flex-col gap-1.5 sm:w-48">
                  <Label htmlFor="referral-reward">单码奖励（分，可选）</Label>
                  <Input
                    id="referral-reward"
                    name="rewardAmount"
                    type="number"
                    min={0}
                    max={2000000000}
                    placeholder="留空用默认"
                  />
                </div>
                <Button type="submit">新建推广码</Button>
              </form>
            ) : null}
          </CardContent>
        </Card>

        {codes.length ? (
          <ul className="flex flex-col divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {codes.map((code) => (
              <li key={code.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-mono font-semibold tracking-wide">
                    {code.code}
                    <StatusBadge tone={code.state === 'active' ? 'ok' : 'neutral'}>
                      {code.state === 'active' ? '启用' : '停用'}
                    </StatusBadge>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {code.label || '未备注'} · 已注册 {code.signupCount} 人 · 奖励{' '}
                    {money(code.rewardAmount, currency)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <CopyLinkButton code={code.code} />
                  {toggleCode ? (
                    <form action={toggleCode}>
                      <input type="hidden" name="id" value={code.id} />
                      <input
                        type="hidden"
                        name="state"
                        value={code.state === 'active' ? 'disabled' : 'active'}
                      />
                      <button
                        type="submit"
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {code.state === 'active' ? '停用' : '启用'}
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text="还没有推广码，先新建一个吧。" />
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Share2 />}>邀请记录</SectionTitle>
        {invites.length ? (
          <div className="overflow-x-auto rounded-2xl border bg-card shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">被邀请人</th>
                  <th className="px-4 py-2.5 font-medium">推广码</th>
                  <th className="px-4 py-2.5 font-medium">奖励</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">时间</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => {
                  const state = INVITER_STATE[invite.inviterState] ?? {
                    label: invite.inviterState,
                    tone: 'neutral' as StatusTone,
                  };
                  return (
                    <tr key={invite.id} className="border-t">
                      <td className="px-4 py-2.5">{invite.inviteeEmail || invite.inviteeId}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{invite.code}</td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {money(invite.rewardAmount, currency)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {formatDate(invite.paidAt ?? invite.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="还没有人通过你的链接注册。" />
        )}
      </section>
    </main>
  );
}

const referralFinders: Record<string, FinderProvider> = {
  'referral.mine': {
    handler: async (_input, ctx) => ctx.api.get('/referral/me', mineSchema),
  },
  'referral.adminList': {
    handler: async (_input, ctx) => ctx.api.get('/store/admin/referrals', adminListSchema),
  },
  'referral.adminConfig': {
    handler: async (_input, ctx) => ctx.api.get('/store/admin/referrals/config', adminConfigSchema),
  },
};

export const frontend: FrontendPackage = {
  finders: referralFinders,
  pages: [],
  pageComponents: {},
  ui: {
    actions: [
      {
        id: 'referral.create-code',
        method: 'POST',
        path: '/referral/codes',
        permission: 'store.referral',
        input: [
          { name: 'label', type: 'string', maxLength: 40 },
          { name: 'rewardAmount', type: 'integer', min: 0, max: 2000000000 },
        ],
      },
      {
        id: 'referral.toggle-code',
        method: 'PATCH',
        path: '/referral/codes/:id',
        permission: 'store.referral',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'state', type: 'string', required: true, maxLength: 16 },
        ],
      },
      {
        id: 'referral.save-config',
        method: 'POST',
        path: '/store/admin/referrals/config',
        permission: 'store.admin',
        input: [
          { name: 'enabled', type: 'boolean', required: true },
          { name: 'trigger', type: 'string', required: true, maxLength: 32 },
          { name: 'rewardAmount', type: 'integer', required: true, min: 0, max: 2000000000 },
          { name: 'inviteeRewardAmount', type: 'integer', required: true, min: 0, max: 2000000000 },
          { name: 'freezeDays', type: 'integer', required: true, min: 0, max: 365 },
          { name: 'cookieDays', type: 'integer', required: true, min: 1, max: 365 },
          { name: 'maxInvitesPerUser', type: 'integer', required: true, min: 0, max: 100000 },
          { name: 'sameIpLimit', type: 'integer', required: true, min: 0, max: 1000 },
          { name: 'currency', type: 'string', required: true, maxLength: 8 },
        ],
      },
      {
        id: 'referral.adjust',
        method: 'POST',
        path: '/store/admin/referrals/adjustments',
        permission: 'store.admin',
        input: [
          { name: 'email', type: 'string', required: true, maxLength: 191 },
          { name: 'amount', type: 'integer', required: true, min: -2000000000, max: 2000000000 },
          { name: 'note', type: 'string', required: true, maxLength: 191 },
        ],
      },
    ],
    accountRoutes: [
      {
        path: '/referral',
        component: 'account/referral',
        permission: 'store.referral',
        nav: { label: '我的推广', group: '推广', order: 20 },
        data: [{ finder: 'referral.mine', as: 'referral' }],
      },
    ],
    adminRoutes: [
      {
        path: '/referrals',
        component: 'admin/referrals',
        permission: 'store.admin',
        systemSettings: { label: '推广', order: 120 },
        data: [
          { finder: 'referral.adminList', as: 'referral' },
          { finder: 'referral.adminConfig', as: 'referralConfig' },
        ],
      },
    ],
    accountPages: {
      'account/referral': ReferralAccountPage,
    },
  },
};

export default frontend;
