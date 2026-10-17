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
import { messages, t } from './i18n.js';

/** Invitee state → message id + tone. Codes are API values, not copy. */
const INVITER_STATE: Record<string, { key: string; tone: StatusTone }> = {
  pending: { key: 'state.pending', tone: 'warn' },
  paid: { key: 'state.paid', tone: 'ok' },
  rejected: { key: 'state.rejected', tone: 'error' },
};

const TRIGGER_KEYS: Record<string, string> = {
  register: 'trigger.register',
  first_order: 'trigger.firstOrder',
  register_frozen: 'trigger.frozenShort',
};

function money(amount: number, currency: string, locale?: string): string {
  // Reward balances are minor units; respect the currency's precision instead
  // of assuming two decimals.
  try {
    return formatMinorCurrency(amount, currency, locale);
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatDate(value: string, locale?: string): string {
  return new Date(value).toLocaleString(locale);
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
  const tr = t(props.locale);
  const referral = props.data.referral as ReturnType<typeof mineSchema.parse> | undefined;
  const createCode = props.actions?.['referral.create-code'];
  const toggleCode = props.actions?.['referral.toggle-code'];

  if (!referral) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader title={tr('page.title')} />
        <p className="text-sm text-muted-foreground">{tr('page.loadFailed')}</p>
      </main>
    );
  }

  const { config, codes, invites, stats } = referral;
  const currency = config.currency;
  const triggerKey = TRIGGER_KEYS[config.trigger];
  const triggerLabel = triggerKey ? tr(triggerKey) : config.trigger;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader title={tr('page.title')} />

      {!config.enabled ? (
        <p
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-300"
        >
          {tr('notice.disabled')}
        </p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={tr('stat.totalInvites')}
          value={String(stats.totalInvites)}
          hint={tr('stat.totalInvitesHint', { days: config.cookieDays })}
        />
        <StatCard
          label={tr('stat.paidInvites')}
          value={String(stats.paidInvites)}
          hint={tr('stat.paidInvitesHint', { trigger: triggerLabel })}
        />
        <StatCard
          label={tr('stat.earned')}
          value={money(stats.earnedAmount, currency, props.locale)}
          hint={tr('stat.earnedHint')}
        />
        <StatCard
          label={tr('stat.balance')}
          value={money(stats.balance, currency, props.locale)}
        />
      </section>

      <Card>
        <CardHeader>
          <SectionTitle icon={<Gift />}>{tr('rules.title')}</SectionTitle>
          <CardDescription>
            {tr('rules.body', {
              inviter: money(config.rewardAmount, currency, props.locale),
              invitee: money(config.inviteeRewardAmount, currency, props.locale),
            })}
          </CardDescription>
        </CardHeader>
      </Card>

      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Link2 />}>{tr('codes.title')}</SectionTitle>

        <Card>
          <CardContent className="pt-6">
            {createCode ? (
              <form action={createCode} className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="referral-label">{tr('codes.labelField')}</Label>
                  <Input
                    id="referral-label"
                    name="label"
                    maxLength={40}
                    placeholder={tr('codes.labelPlaceholder')}
                  />
                </div>
                <div className="flex w-full flex-col gap-1.5 sm:w-48">
                  <Label htmlFor="referral-reward">{tr('codes.rewardField')}</Label>
                  <Input
                    id="referral-reward"
                    name="rewardAmount"
                    type="number"
                    min={0}
                    max={2000000000}
                    placeholder={tr('codes.rewardPlaceholder')}
                  />
                </div>
                <Button type="submit">{tr('codes.create')}</Button>
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
                      {code.state === 'active' ? tr('codes.active') : tr('codes.disabled')}
                    </StatusBadge>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tr('codes.summary', {
                      label: code.label || tr('codes.noLabel'),
                      count: code.signupCount,
                      amount: money(code.rewardAmount, currency, props.locale),
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <CopyLinkButton
                    code={code.code}
                    copyLabel={tr('codes.copy')}
                    copiedLabel={tr('codes.copied')}
                  />
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
                        {code.state === 'active' ? tr('codes.disabled') : tr('codes.active')}
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={tr('codes.empty')} />
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Share2 />}>{tr('invites.title')}</SectionTitle>
        {invites.length ? (
          <div className="overflow-x-auto rounded-2xl border bg-card shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{tr('invites.colInvitee')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('invites.colCode')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('invites.colReward')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('invites.colState')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('invites.colTime')}</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => {
                  const state = INVITER_STATE[invite.inviterState];
                  return (
                    <tr key={invite.id} className="border-t">
                      <td className="px-4 py-2.5">{invite.inviteeEmail || invite.inviteeId}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{invite.code}</td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {money(invite.rewardAmount, currency, props.locale)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge tone={state?.tone ?? 'neutral'}>
                          {state ? tr(state.key) : invite.inviterState}
                        </StatusBadge>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {formatDate(invite.paidAt ?? invite.createdAt, props.locale)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text={tr('invites.empty')} />
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
  locales: ['zh-CN', 'en-US'],
  messages,
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
        nav: { labelKey: 'nav.label', groupKey: 'nav.group', order: 20 },
        data: [{ finder: 'referral.mine', as: 'referral' }],
      },
    ],
    adminRoutes: [
      {
        path: '/referrals',
        component: 'admin/referrals',
        permission: 'store.admin',
        systemSettings: {
          labelKey: 'admin.systemSettings',
          order: 120,
        },
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
