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

const TRIGGER_OPTIONS = [
  { value: 'register', label: '注册即发' },
  { value: 'first_order', label: '首单支付后发（默认）' },
  { value: 'register_frozen', label: '冻结 N 天后解冻发' },
];

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

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}

function ConfigForm({
  config,
  action,
}: {
  config: AdminConfigData['config'];
  action?: ((formData: FormData) => Promise<void>) | undefined;
}): ReactElement {
  const [trigger, setTrigger] = useState(config.trigger);
  if (!action) {
    return (
      <Card>
        <CardHeader>
          <SectionTitle icon={<Settings />}>推广配置</SectionTitle>
          <CardDescription>当前无法保存配置（缺少权限或未登录）。</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Settings />}>推广配置</SectionTitle>
        <CardDescription>设置邀请奖励和归因规则，保存后立即对新邀请生效。</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-7">
          <input type="hidden" name="rewardAmount" value={config.rewardAmount} />
          <input type="hidden" name="inviteeRewardAmount" value={config.inviteeRewardAmount} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-enabled">启用推广</Label>
              <Select
                id="cfg-enabled"
                name="enabled"
                defaultValue={config.enabled ? 'true' : 'false'}
              >
                <option value="true">启用</option>
                <option value="false">停用</option>
              </Select>
              <p className="text-xs text-muted-foreground">
                关闭后不会生成新的奖励，已有记录不受影响。
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-trigger">什么时候发放奖励</Label>
              <Select
                id="cfg-trigger"
                name="trigger"
                value={trigger}
                onChange={(event) => setTrigger(event.target.value)}
              >
                {TRIGGER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                建议选择“首单支付后发”，可减少无效注册。
              </p>
            </div>
          </div>
          <div className="grid gap-4 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-reward-yuan">推广人奖励（元）</Label>
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
              <p className="text-xs text-muted-foreground">邀请成功后，发给推广人的余额奖励。</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-invitee-reward-yuan">新用户奖励（元）</Label>
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
                被邀请的新用户获得的余额奖励，填 0 即不发放。
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-currency">结算币种</Label>
              {/* Rewards are paid into the CNY wallet; keep it fixed but visible. */}
              <Input id="cfg-currency" name="currency" value={config.currency} readOnly />
              <p className="text-xs text-muted-foreground">
                推广奖励进入钱包，当前钱包仅支持 CNY。
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-freeze">冻结天数</Label>
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
              <p className="text-xs text-muted-foreground">仅在选择“冻结后发”时使用。</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-cookie">邀请链接有效期（天）</Label>
              <Input
                id="cfg-cookie"
                name="cookieDays"
                type="number"
                min={1}
                max={365}
                defaultValue={config.cookieDays}
                required
              />
              <p className="text-xs text-muted-foreground">
                点击邀请链接后，多少天内注册仍算有效。
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-max-invites">每位用户最多邀请</Label>
              <Input
                id="cfg-max-invites"
                name="maxInvitesPerUser"
                type="number"
                min={0}
                max={100000}
                defaultValue={config.maxInvitesPerUser}
                required
              />
              <p className="text-xs text-muted-foreground">填写 0 表示不限制人数。</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-same-ip">同一网络最多计入</Label>
              <Input
                id="cfg-same-ip"
                name="sameIpLimit"
                type="number"
                min={0}
                max={1000}
                defaultValue={config.sameIpLimit}
                required
              />
              <p className="text-xs text-muted-foreground">
                用于减少自邀刷奖励，填写 0 表示不限制。
              </p>
            </div>
          </div>
          <div className="flex items-end sm:col-span-2 lg:col-span-3">
            <Button type="submit">保存配置</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function AdjustmentForm({
  action,
  currency,
}: {
  action?: ((formData: FormData) => Promise<void>) | undefined;
  currency: string;
}): ReactElement {
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Users />}>手动调账</SectionTitle>
        <CardDescription>
          奖励漏发或误发时人工修正：按邮箱给用户余额加减金额（正数增加、负数扣减）。
        </CardDescription>
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
              <Label htmlFor="adj-email">用户邮箱</Label>
              <Input id="adj-email" name="email" type="email" required maxLength={191} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adj-amount">金额（元，{currency}）</Label>
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
              <Label htmlFor="adj-note">备注</Label>
              <Input
                id="adj-note"
                name="note"
                required
                maxLength={191}
                placeholder="例如：补发 2026-10 奖励"
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" variant="outline">
                提交调账
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">当前无法调账（缺少权限或未登录）。</p>
        )}
      </CardContent>
    </Card>
  );
}

function ReferralAdminPage(props: AdminPageComponentProps): ReactElement {
  const list = props.data.referral as AdminListData | undefined;
  const configData = props.data.referralConfig as AdminConfigData | undefined;
  const currency = configData?.config.currency ?? list?.currency ?? 'CNY';
  const records = list?.records ?? [];
  const inviters = list?.inviters ?? [];

  return (
    <main className="flex w-full flex-col gap-8">
      {props.embedded ? null : <PageHeader title="推广管理" />}

      {list ? (
        <section className="grid gap-3 sm:grid-cols-3">
          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <BarChart3 className="size-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">累计归因</p>
                <p className="text-xl font-semibold tabular-nums">{list.total}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <Users className="size-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">推广人</p>
                <p className="text-xl font-semibold tabular-nums">{inviters.length}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="py-4">
            <CardContent>
              <p className="text-xs text-muted-foreground">当前结算币种</p>
              <p className="text-xl font-semibold">{currency}</p>
            </CardContent>
          </Card>
        </section>
      ) : null}

      {configData ? (
        <ConfigForm config={configData.config} action={props.actions?.['referral.save-config']} />
      ) : null}

      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Users />}>推广人汇总</SectionTitle>
        {inviters.length ? (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">推广人</th>
                  <th className="px-4 py-2.5 font-medium">已发奖励</th>
                </tr>
              </thead>
              <tbody>
                {inviters.map((inviter) => (
                  <tr key={inviter.inviterId} className="border-t">
                    <td className="px-4 py-2.5">{inviter.inviterEmail || inviter.inviterId}</td>
                    <td className="px-4 py-2.5 tabular-nums">
                      {money(inviter.paidAmount, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">暂无已发奖励的推广人。</p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Users />}>归因明细（共 {list?.total ?? 0} 条）</SectionTitle>
        {records.length ? (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">推广人</th>
                  <th className="px-4 py-2.5 font-medium">被邀请人</th>
                  <th className="px-4 py-2.5 font-medium">码</th>
                  <th className="px-4 py-2.5 font-medium">奖励</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">时间</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => {
                  const state = INVITER_STATE[record.inviterState] ?? {
                    label: record.inviterState,
                    tone: 'neutral' as StatusTone,
                  };
                  return (
                    <tr key={record.id} className="border-t">
                      <td className="px-4 py-2.5">{record.inviterEmail || record.inviterId}</td>
                      <td className="px-4 py-2.5">{record.inviteeEmail || record.inviteeId}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{record.code}</td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {money(record.rewardAmount, currency)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {formatDate(record.paidAt ?? record.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">暂无归因记录。</p>
        )}
      </section>

      {list ? (
        <AdjustmentForm action={props.actions?.['referral.adjust']} currency={currency} />
      ) : null}
    </main>
  );
}

export const adminPages = {
  'admin/referrals': ReferralAdminPage,
} as const;
