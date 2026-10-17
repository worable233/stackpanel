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
import type { ReactElement } from 'react';
import { Settings, Users } from 'lucide-react';
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
  return `${(amount / 100).toFixed(2)} ${currency}`;
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
        <CardDescription>奖励金额单位为分；改为 0 表示不发放该侧奖励。</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cfg-enabled">启用推广</Label>
            <Select id="cfg-enabled" name="enabled" defaultValue={config.enabled ? 'true' : 'false'}>
              <option value="true">启用</option>
              <option value="false">停用</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cfg-trigger">发奖时点</Label>
            <Select id="cfg-trigger" name="trigger" defaultValue={config.trigger}>
              {TRIGGER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cfg-currency">结算币种</Label>
            <Input id="cfg-currency" name="currency" defaultValue={config.currency} maxLength={8} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cfg-reward">推广人奖励（分）</Label>
            <Input
              id="cfg-reward"
              name="rewardAmount"
              type="number"
              min={0}
              max={2000000000}
              defaultValue={config.rewardAmount}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cfg-invitee-reward">被邀请人奖励（分）</Label>
            <Input
              id="cfg-invitee-reward"
              name="inviteeRewardAmount"
              type="number"
              min={0}
              max={2000000000}
              defaultValue={config.inviteeRewardAmount}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cfg-freeze">冻结天数</Label>
            <Input
              id="cfg-freeze"
              name="freezeDays"
              type="number"
              min={0}
              max={365}
              defaultValue={config.freezeDays}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cfg-cookie">归因有效期（天）</Label>
            <Input
              id="cfg-cookie"
              name="cookieDays"
              type="number"
              min={1}
              max={365}
              defaultValue={config.cookieDays}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cfg-max-invites">单账号邀请上限（0 不限）</Label>
            <Input
              id="cfg-max-invites"
              name="maxInvitesPerUser"
              type="number"
              min={0}
              max={100000}
              defaultValue={config.maxInvitesPerUser}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cfg-same-ip">同 IP 归因上限（0 不限）</Label>
            <Input
              id="cfg-same-ip"
              name="sameIpLimit"
              type="number"
              min={0}
              max={1000}
              defaultValue={config.sameIpLimit}
              required
            />
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
          奖励漏发或误发时人工修正：按邮箱给用户余额加减金额（正数增加、负数扣减），单位为分。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {action ? (
          <form action={action} className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_minmax(0,1.4fr)_auto]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adj-email">用户邮箱</Label>
              <Input id="adj-email" name="email" type="email" required maxLength={191} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adj-amount">金额（分，{currency}）</Label>
              <Input
                id="adj-amount"
                name="amount"
                type="number"
                required
                min={-2000000000}
                max={2000000000}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adj-note">备注</Label>
              <Input id="adj-note" name="note" required maxLength={191} placeholder="例如：补发 2026-10 奖励" />
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
      <PageHeader title="推广管理" />

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
                    <td className="px-4 py-2.5">
                      {inviter.inviterEmail || inviter.inviterId}
                    </td>
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
        <SectionTitle icon={<Users />}>归因明细（最近 {list?.total ?? 0} 条）</SectionTitle>
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
