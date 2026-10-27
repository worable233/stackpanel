'use client';

import { SectionTitle, Select } from '@stackpanel/ui';
import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { DistributionSourceConfig } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useTranslator } from '@/i18n/provider';
import {
  refreshDistributionAction,
  saveCatalogKeyAction,
  saveCatalogTokenAction,
  saveDistributionSourceAction,
  type SettingsActionState,
} from '@/lib/settings-actions';

/**
 * 分发源（应用市场）配置（PLAN-github-distribution §2/§10）。
 *
 * 过去这些只能改 `.env` 并重启；现在后台可编辑，保存后立即重建目录协调器。
 * token 只写不读：表单永远空白，只显示「已保存」状态。
 */
export function DistributionSourceSettings({
  source,
  defaults,
}: {
  source: DistributionSourceConfig;
  defaults?: { repository: string | null; mirror: string | null } | undefined;
}) {
  const t = useTranslator();
  const router = useRouter();
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    saveDistributionSourceAction,
    {},
  );
  const [keyState, keyAction, keyPending] = useActionState<SettingsActionState, FormData>(
    saveCatalogKeyAction,
    {},
  );
  const [tokenState, tokenAction, tokenPending] = useActionState<SettingsActionState, FormData>(
    saveCatalogTokenAction,
    {},
  );
  const [refreshState, setRefreshState] = useState<SettingsActionState>({});
  const [refreshing, startRefresh] = useTransition();
  const [isMutating, startTransition] = useTransition();
  const remoteEnabled = source.repository !== null;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <SectionTitle>{t('admin.settings.distribution.title')}</SectionTitle>
        <p className="text-sm text-muted-foreground">
          {t('admin.settings.distribution.description')}
        </p>
        <p className="text-xs text-muted-foreground">
          {source.source === 'stored'
            ? t('admin.settings.distribution.sourceStored')
            : t('admin.settings.distribution.sourceEnv')}
          {source.envRepository
            ? ` · ${t('admin.settings.distribution.envHint', { repository: source.envRepository })}`
            : ''}
        </p>
      </div>

      <form
        action={(formData) => {
          startTransition(async () => {
            await action(formData);
            // 保存成功后旧的刷新结果已过期，避免两条提示互相矛盾。
            setRefreshState({});
            router.refresh();
          });
        }}
        className="flex flex-col gap-6"
      >
        <div className="flex items-center gap-2">
          <Checkbox
            id="remoteEnabled"
            name="remoteEnabled"
            defaultChecked={remoteEnabled}
          />
          <Label htmlFor="remoteEnabled">{t('admin.settings.distribution.remoteEnabled')}</Label>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="repository">{t('admin.settings.distribution.repository')}</Label>
          <Input
            id="repository"
            name="repository"
            defaultValue={source.repository ?? ''}
            placeholder="worable233/stackpanel-plugins"
            maxLength={300}
          />
          <p className="text-xs text-muted-foreground">
            {t('admin.settings.distribution.repositoryHint', {
              repository: defaults?.repository ?? 'worable233/stackpanel-plugins',
            })}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel">{t('admin.settings.distribution.channel')}</Label>
            <Select
              id="channel"
              name="channel"
              defaultValue={source.channel}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="stable">{t('admin.settings.distribution.channelStable')}</option>
              <option value="beta">{t('admin.settings.distribution.channelBeta')}</option>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ref">{t('admin.settings.distribution.ref')}</Label>
            <Input id="ref" name="ref" defaultValue={source.ref} maxLength={120} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="mirror">{t('admin.settings.distribution.mirror')}</Label>
          <Input
            id="mirror"
            name="mirror"
            type="url"
            defaultValue={source.mirror ?? ''}
            placeholder="https://github.chenc.dev"
            maxLength={300}
          />
          <p className="text-xs text-muted-foreground">
            {t('admin.settings.distribution.mirrorHint')}
          </p>
          {source.envMirror ? (
            <p className="text-xs text-muted-foreground">
              {t('admin.settings.distribution.envMirrorHint', { mirror: source.envMirror })}
            </p>
          ) : null}
        </div>

        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.ok && state.message ? (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending || isMutating}>
            {pending || isMutating
              ? t('admin.settings.saving')
              : t('admin.settings.distribution.submit')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={refreshing}
            onClick={() => {
              startRefresh(async () => {
                setRefreshState(await refreshDistributionAction());
                router.refresh();
              });
            }}
          >
            {refreshing
              ? t('admin.settings.distribution.refreshing')
              : t('admin.settings.distribution.refresh')}
          </Button>
        </div>
        {refreshState.error ? (
          <p className="text-sm text-destructive">{refreshState.error}</p>
        ) : null}
        {refreshState.ok && refreshState.message ? (
          <p className="text-sm text-muted-foreground">{refreshState.message}</p>
        ) : null}
      </form>

      <form
        action={(formData) => {
          startTransition(async () => {
            await keyAction(formData);
            router.refresh();
          });
        }}
        className="flex flex-col gap-4 pt-2"
      >
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">
            {t('admin.settings.distribution.catalogKeyTitle')}
          </h3>
          <p className="text-sm text-muted-foreground">
            {source.publicKey
              ? t('admin.settings.distribution.catalogKeyConfigured')
              : t('admin.settings.distribution.catalogKeyUnconfigured')}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="catalogPublicKey">
            {t('admin.settings.distribution.catalogKeyLabel')}
          </Label>
          <textarea
            id="catalogPublicKey"
            name="publicKey"
            rows={6}
            defaultValue={source.publicKey ?? ''}
            className="w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            placeholder="-----BEGIN PUBLIC KEY-----&#10;...&#10;-----END PUBLIC KEY-----"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="catalogPublicKeyId">
            {t('admin.settings.distribution.catalogKeyIdLabel')}
          </Label>
          <Input
            id="catalogPublicKeyId"
            name="keyId"
            defaultValue={source.publicKeyId ?? ''}
            placeholder="catalog-2026"
          />
          <p className="text-xs text-muted-foreground">
            {t('admin.settings.distribution.catalogKeyIdHint')}
          </p>
        </div>
        {keyState.error ? <p className="text-sm text-destructive">{keyState.error}</p> : null}
        {keyState.ok && keyState.message ? (
          <p className="text-sm text-muted-foreground">{keyState.message}</p>
        ) : null}
        <div>
          <Button type="submit" variant="outline" disabled={keyPending || isMutating}>
            {keyPending || isMutating
              ? t('admin.settings.saving')
              : t('admin.settings.distribution.catalogKeySubmit')}
          </Button>
        </div>
      </form>

      <form
        action={(formData) => {
          startTransition(async () => {
            await tokenAction(formData);
            router.refresh();
          });
        }}
        className="flex flex-col gap-4 pt-2"
      >
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">
            {t('admin.settings.distribution.catalogTokenTitle')}
          </h3>
          <p className="text-sm text-muted-foreground">
            {source.secretsEnabled
              ? source.tokenConfigured
                ? t('admin.settings.distribution.catalogTokenConfigured')
                : t('admin.settings.distribution.catalogTokenUnconfigured')
              : t('admin.settings.distribution.catalogTokenDisabled')}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="catalogToken">{t('admin.settings.distribution.catalogTokenLabel')}</Label>
          <Input
            id="catalogToken"
            name="token"
            type="password"
            autoComplete="off"
            disabled={!source.secretsEnabled}
            placeholder={
              source.tokenConfigured
                ? t('admin.settings.distribution.catalogTokenPlaceholderSaved')
                : 'github_pat_...'
            }
            maxLength={4096}
          />
        </div>
        {tokenState.error ? <p className="text-sm text-destructive">{tokenState.error}</p> : null}
        {tokenState.ok && tokenState.message ? (
          <p className="text-sm text-muted-foreground">{tokenState.message}</p>
        ) : null}
        <div>
          <Button
            type="submit"
            variant="outline"
            disabled={tokenPending || isMutating || !source.secretsEnabled}
          >
            {tokenPending || isMutating
              ? t('admin.settings.saving')
              : t('admin.settings.distribution.catalogTokenSubmit')}
          </Button>
        </div>
      </form>
    </section>
  );
}
