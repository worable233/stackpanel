'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  Input,
  Label,
  PageHeader,
  SectionTitle,
  Select,
  StatusBadge,
  type StatusTone,
} from '@stackpanel/ui';
import { formatMinorCurrency, minorUnitsToPlainString, toMinorUnits } from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import { BarChart3, Settings, Users } from 'lucide-react';
import { useState } from 'react';
import type { AdminConfigData, AdminListData } from './schemas';
import { t } from './i18n.js';

/** Trigger options: `value` is the persisted contract, `key` is display copy. */
const TRIGGER_OPTIONS = [
  { value: 'register', key: 'trigger.register' },
  { value: 'first_order', key: 'trigger.firstOrderOption' },
  { value: 'register_frozen', key: 'trigger.registerFrozen' },
];

/** Invitee state → message id + tone. Codes are API values, not copy. */
const INVITER_STATE: Record<string, { key: string; tone: StatusTone }> = {
  pending: { key: 'state.pending', tone: 'warn' },
  paid: { key: 'state.paid', tone: 'ok' },
  rejected: { key: 'state.rejected', tone: 'error' },
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

/** Parse a major-unit input to minor units, or null when it does not fit. */
function parseMinor(value: string, currency: string): number | null {
  try {
    return toMinorUnits(value, currency);
  } catch {
    return null;
  }
}

/** Exact editable string for a minor-unit amount, per the currency precision. */
function amountInput(value: number, currency: string): string {
  try {
    return minorUnitsToPlainString(value, currency);
  } catch {
    return String(value);
  }
}

function formatDate(value: string, locale?: string): string {
  return new Date(value).toLocaleString(locale);
}

function ConfigForm({
  config,
  action,
  tr,
}: {
  config: AdminConfigData['config'];
  action?: ((formData: FormData) => Promise<void>) | undefined;
  tr: ReturnType<typeof t>;
}): ReactElement {
  const [trigger, setTrigger] = useState(config.trigger);
  if (!action) {
    return (
      <Card>
        <CardHeader>
          <SectionTitle icon={<Settings />}>{tr('admin.config.title')}</SectionTitle>
          <CardDescription>{tr('admin.config.noPermission')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Settings />}>{tr('admin.config.title')}</SectionTitle>
        <CardDescription>{tr('admin.config.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-7">
          <input type="hidden" name="rewardAmount" value={config.rewardAmount} />
          <input type="hidden" name="inviteeRewardAmount" value={config.inviteeRewardAmount} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-enabled">{tr('admin.config.enabled')}</Label>
              <Select
                id="cfg-enabled"
                name="enabled"
                defaultValue={config.enabled ? 'true' : 'false'}
              >
                <option value="true">{tr('admin.config.enabledOn')}</option>
                <option value="false">{tr('admin.config.enabledOff')}</option>
              </Select>
              <p className="text-xs text-muted-foreground">{tr('admin.config.enabledHint')}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-trigger">{tr('admin.config.trigger')}</Label>
              <Select
                id="cfg-trigger"
                name="trigger"
                value={trigger}
                onChange={(event) => setTrigger(event.target.value)}
              >
                {TRIGGER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {tr(option.key)}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">{tr('admin.config.triggerHint')}</p>
            </div>
          </div>
          <div className="grid gap-4 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-reward-yuan">{tr('admin.config.reward')}</Label>
              <Input
                id="cfg-reward-yuan"
                type="number"
                min={0}
                max={20000000}
                step="0.01"
                defaultValue={amountInput(config.rewardAmount, config.currency)}
                required
                onChange={(event) => {
                  const minor = parseMinor(event.target.value, config.currency);
                  if (minor !== null)
                    (
                      event.currentTarget.form?.elements.namedItem(
                        'rewardAmount',
                      ) as HTMLInputElement
                    ).value = String(minor);
                }}
              />
              <p className="text-xs text-muted-foreground">{tr('admin.config.rewardHint')}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-invitee-reward-yuan">{tr('admin.config.inviteeReward')}</Label>
              <Input
                id="cfg-invitee-reward-yuan"
                type="number"
                min={0}
                max={20000000}
                step="0.01"
                defaultValue={amountInput(config.inviteeRewardAmount, config.currency)}
                required
                onChange={(event) => {
                  const minor = parseMinor(event.target.value, config.currency);
                  if (minor !== null)
                    (
                      event.currentTarget.form?.elements.namedItem(
                        'inviteeRewardAmount',
                      ) as HTMLInputElement
                    ).value = String(minor);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {tr('admin.config.inviteeRewardHint')}
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-currency">{tr('admin.config.currency')}</Label>
              {/* Rewards are paid into the CNY wallet; keep it fixed but visible. */}
              <Input id="cfg-currency" name="currency" value={config.currency} readOnly />
              <p className="text-xs text-muted-foreground">{tr('admin.config.currencyHint')}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-freeze">{tr('admin.config.freezeDays')}</Label>
              {trigger !== 'register_frozen' ? (
                <input type="hidden" name="freezeDays" value={config.freezeDays} />
              ) : null}
              <Input
                id="cfg-freeze"
                name="freezeDays"
                type="number"
                min={0}
                max={365}
                defaultValue={config.freezeDays}
                required
                disabled={trigger !== 'register_frozen'}
              />
              <p className="text-xs text-muted-foreground">{tr('admin.config.freezeDaysHint')}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-cookie">{tr('admin.config.cookieDays')}</Label>
              <Input
                id="cfg-cookie"
                name="cookieDays"
                type="number"
                min={1}
                max={365}
                defaultValue={config.cookieDays}
                required
              />
              <p className="text-xs text-muted-foreground">{tr('admin.config.cookieDaysHint')}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-max-invites">{tr('admin.config.maxInvites')}</Label>
              <Input
                id="cfg-max-invites"
                name="maxInvitesPerUser"
                type="number"
                min={0}
                max={100000}
                defaultValue={config.maxInvitesPerUser}
                required
              />
              <p className="text-xs text-muted-foreground">{tr('admin.config.maxInvitesHint')}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-same-ip">{tr('admin.config.sameIp')}</Label>
              <Input
                id="cfg-same-ip"
                name="sameIpLimit"
                type="number"
                min={0}
                max={1000}
                defaultValue={config.sameIpLimit}
                required
              />
              <p className="text-xs text-muted-foreground">{tr('admin.config.sameIpHint')}</p>
            </div>
          </div>
          <div className="flex items-end sm:col-span-2 lg:col-span-3">
            <Button type="submit">{tr('admin.config.save')}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function AdjustmentForm({
  action,
  currency,
  tr,
}: {
  action?: ((formData: FormData) => Promise<void>) | undefined;
  currency: string;
  tr: ReturnType<typeof t>;
}): ReactElement {
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Users />}>{tr('admin.adjust.title')}</SectionTitle>
        <CardDescription>{tr('admin.adjust.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {action ? (
          <form
            action={async (formData) => {
              const amount = Number(String(formData.get('amountYuan') ?? '').trim());
              if (Number.isFinite(amount)) formData.set('amount', String(Math.round(amount * 100)));
              formData.delete('amountYuan');
              await action(formData);
            }}
            className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_minmax(0,1.4fr)_auto]"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adj-email">{tr('admin.adjust.email')}</Label>
              <Input id="adj-email" name="email" type="email" required maxLength={191} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adj-amount">{tr('admin.adjust.amount', { currency })}</Label>
              <Input
                id="adj-amount"
                name="amountYuan"
                type="number"
                required
                min={-20000000}
                max={20000000}
                step="0.01"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adj-note">{tr('admin.adjust.note')}</Label>
              <Input
                id="adj-note"
                name="note"
                required
                maxLength={191}
                placeholder={tr('admin.adjust.amountPlaceholder')}
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" variant="outline">
                {tr('admin.adjust.submit')}
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{tr('admin.adjust.noPermission')}</p>
        )}
      </CardContent>
    </Card>
  );
}

function ReferralAdminPage(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const list = props.data.referral as AdminListData | undefined;
  const configData = props.data.referralConfig as AdminConfigData | undefined;
  const currency = configData?.config.currency ?? list?.currency ?? 'CNY';
  const records = list?.records ?? [];
  const inviters = list?.inviters ?? [];

  return (
    <main className="flex w-full flex-col gap-8">
      {props.embedded ? null : <PageHeader title={tr('admin.title')} />}

      {list ? (
        <section className="grid gap-3 sm:grid-cols-3">
          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <BarChart3 className="size-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">{tr('admin.stat.attributed')}</p>
                <p className="text-xl font-semibold tabular-nums">{list.total}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <Users className="size-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">{tr('admin.stat.inviters')}</p>
                <p className="text-xl font-semibold tabular-nums">{inviters.length}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="py-4">
            <CardContent>
              <p className="text-xs text-muted-foreground">{tr('admin.stat.currency')}</p>
              <p className="text-xl font-semibold">{currency}</p>
            </CardContent>
          </Card>
        </section>
      ) : null}

      {configData ? (
        <ConfigForm
          config={configData.config}
          action={props.actions?.['referral.save-config']}
          tr={tr}
        />
      ) : null}

      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Users />}>{tr('admin.inviters.title')}</SectionTitle>
        {inviters.length ? (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{tr('admin.inviters.colInviter')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('admin.inviters.colPaid')}</th>
                </tr>
              </thead>
              <tbody>
                {inviters.map((inviter) => (
                  <tr key={inviter.inviterId} className="border-t">
                    <td className="px-4 py-2.5">{inviter.inviterEmail || inviter.inviterId}</td>
                    <td className="px-4 py-2.5 tabular-nums">
                      {money(inviter.paidAmount, currency, props.locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{tr('admin.inviters.empty')}</p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Users />}>
          {tr('admin.records.title', { count: list?.total ?? 0 })}
        </SectionTitle>
        {records.length ? (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{tr('admin.records.colInviter')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('admin.records.colInvitee')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('admin.records.colCode')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('admin.records.colReward')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('admin.records.colState')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('admin.records.colTime')}</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => {
                  const state = INVITER_STATE[record.inviterState];
                  return (
                    <tr key={record.id} className="border-t">
                      <td className="px-4 py-2.5">{record.inviterEmail || record.inviterId}</td>
                      <td className="px-4 py-2.5">{record.inviteeEmail || record.inviteeId}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{record.code}</td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {money(record.rewardAmount, currency, props.locale)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge tone={state?.tone ?? 'neutral'}>
                          {state ? tr(state.key) : record.inviterState}
                        </StatusBadge>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {formatDate(record.paidAt ?? record.createdAt, props.locale)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{tr('admin.records.empty')}</p>
        )}
      </section>

      {list ? (
        <AdjustmentForm action={props.actions?.['referral.adjust']} currency={currency} tr={tr} />
      ) : null}
    </main>
  );
}

export const adminPages = {
  'admin/referrals': ReferralAdminPage,
} as const;
