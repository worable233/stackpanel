'use client';

import { SectionTitle, Select } from '@stackpanel/ui';
import { useActionState, useState } from 'react';
import type { UpdatePolicyView } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useTranslator } from '@/i18n/provider';
import { saveUpdatePolicyAction, type UpdateCenterState } from '@/lib/update-actions';

/**
 * 更新与升级策略（PLAN-github-distribution-and-updates §4/§9）。
 *
 * 这是「后台设置页」缺失的那一块：`PUT /admin/updates/policy` 一直是完整的，但没有
 * 任何界面，`autoUpdate` / 渠道 / 维护窗口 / 例外 / 两个危险放行只能改数据库。
 *
 * 交互约定：
 * - 保存后**回填服务端返回值**，不做乐观更新（策略是安全边界，显示必须等于持久值）。
 * - 两个 `allow*` 显式标注危险，默认关闭；它们放宽的是「自动更新可以不经人工确认」的闸门。
 * - 维护窗口取消勾选会提交 `maintenanceWindow: null`（清除限制），否则一旦设过就关不掉。
 */
export function UpdatePolicySettings({ policy }: { policy: UpdatePolicyView }) {
  const t = useTranslator();
  const [state, action, pending] = useActionState<UpdateCenterState, FormData>(
    saveUpdatePolicyAction,
    {},
  );
  const [windowEnabled, setWindowEnabled] = useState(Boolean(policy.maintenanceWindow));
  const window = policy.maintenanceWindow;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <SectionTitle>{t('admin.settings.updates.title')}</SectionTitle>
        <p className="text-sm text-muted-foreground">{t('admin.settings.updates.description')}</p>
        <p className="text-xs text-muted-foreground">
          {policy.updatedAt
            ? t('admin.settings.updates.updatedBy', {
                at: new Date(policy.updatedAt).toLocaleString(),
                by: policy.updatedBy ?? '—',
              })
            : t('admin.settings.updates.neverUpdated')}
        </p>
      </div>

      <form action={action} className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2">
            <Checkbox className="mt-0.5" id="autoUpdate" name="autoUpdate" defaultChecked={policy.autoUpdate} />
            <Label htmlFor="autoUpdate">{t('admin.settings.updates.autoUpdate')}</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.settings.updates.autoUpdateHint')}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel">{t('admin.settings.updates.channel')}</Label>
            <Select
              id="channel"
              name="channel"
              defaultValue={policy.channel}
              className="h-10 w-full bg-muted/40"
            >
              <option value="stable">{t('admin.settings.updates.channelStable')}</option>
              <option value="beta">{t('admin.settings.updates.channelBeta')}</option>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t('admin.settings.updates.channelHint')}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <Checkbox className="mt-0.5"
                id="autoUpdateKernel"
                name="autoUpdateKernel"
                defaultChecked={policy.autoUpdateKernel}
              />
              <Label htmlFor="autoUpdateKernel">
                {t('admin.settings.updates.autoUpdateKernel')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('admin.settings.updates.autoUpdateKernelHint')}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2">
            <Checkbox className="mt-0.5"
              id="windowEnabled"
              name="windowEnabled"
              checked={windowEnabled}
              onCheckedChange={(checked) => setWindowEnabled(checked === true)}
            />
            <Label htmlFor="windowEnabled">{t('admin.settings.updates.maintenanceWindow')}</Label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="windowStart">{t('admin.settings.updates.windowStart')}</Label>
              <Input
                id="windowStart"
                name="windowStart"
                type="number"
                min={0}
                max={23}
                disabled={!windowEnabled}
                defaultValue={window ? String(window.startHour) : ''}
                placeholder="23"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="windowEnd">{t('admin.settings.updates.windowEnd')}</Label>
              <Input
                id="windowEnd"
                name="windowEnd"
                type="number"
                min={0}
                max={23}
                disabled={!windowEnabled}
                defaultValue={window ? String(window.endHour) : ''}
                placeholder="5"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.settings.updates.maintenanceWindowHint')}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="excluded">{t('admin.settings.updates.excluded')}</Label>
          <textarea
            id="excluded"
            name="excluded"
            rows={4}
            defaultValue={policy.excluded.join('\n')}
            placeholder={'plugin/referral\ntheme/atlas'}
            className="w-full rounded-[10px] border border-border/80 bg-background px-3.5 py-2 font-mono text-sm text-foreground outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
          />
          <p className="text-xs text-muted-foreground">
            {t('admin.settings.updates.excludedHint')}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="pinned">{t('admin.settings.updates.pinned')}</Label>
          <textarea
            id="pinned"
            name="pinned"
            rows={4}
            defaultValue={Object.entries(policy.pinned)
              .map(([key, version]) => `${key} ${version}`)
              .join('\n')}
            placeholder={'plugin/referral 1.2.0'}
            className="w-full rounded-[10px] border border-border/80 bg-background px-3.5 py-2 font-mono text-sm text-foreground outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
          />
          <p className="text-xs text-muted-foreground">{t('admin.settings.updates.pinnedHint')}</p>
        </div>

        <div className="flex flex-col gap-3 rounded-2xl bg-destructive/10 p-4">
          <div className="flex items-start gap-2">
            <Checkbox className="mt-0.5"
              id="allowPermissionIncrease"
              name="allowPermissionIncrease"
              defaultChecked={policy.allowPermissionIncrease}
            />
            <Label htmlFor="allowPermissionIncrease">
              {t('admin.settings.updates.allowPermissionIncrease')}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.settings.updates.allowPermissionIncreaseHint')}
          </p>
          <div className="flex items-start gap-2">
            <Checkbox className="mt-0.5"
              id="allowIrreversibleMigration"
              name="allowIrreversibleMigration"
              defaultChecked={policy.allowIrreversibleMigration}
            />
            <Label htmlFor="allowIrreversibleMigration">
              {t('admin.settings.updates.allowIrreversibleMigration')}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.settings.updates.allowIrreversibleMigrationHint')}
          </p>
        </div>

        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.ok && state.message ? (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? t('admin.settings.updates.saving') : t('admin.settings.updates.submit')}
          </Button>
        </div>
      </form>
    </section>
  );
}
