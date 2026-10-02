'use client';

import { useActionState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PlatformInfo, SigningStatus } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  clearPlatformBrandAction,
  savePlatformBrandAction,
  savePlatformInfoAction,
  saveSigningAction,
  type SettingsActionState,
} from '@/lib/settings-actions';
import { useTranslator } from '@/i18n/provider';

export interface BrandAssets {
  logoUrl: string | null;
  faviconUrl: string | null;
}

export function SettingsManager({
  platform,
  signing,
  brand,
}: {
  platform: PlatformInfo;
  signing: SigningStatus | null;
  brand: BrandAssets | null;
}) {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PlatformInfoSettings platform={platform} />
      <BrandSettings brand={brand} />
      <SigningSettings signing={signing} />
    </div>
  );
}

function PlatformInfoSettings({ platform }: { platform: PlatformInfo }) {
  const router = useRouter();
  const t = useTranslator();
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    savePlatformInfoAction,
    {},
  );
  const [isMutating, startTransition] = useTransition();

  return (
    <section className="flex flex-col gap-5 rounded-lg border bg-card p-5 text-card-foreground shadow-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t('admin.settings.platform.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('admin.settings.platform.description')}</p>
      </div>
      <form
        action={(formData) => {
          startTransition(async () => {
            await action(formData);
            router.refresh();
          });
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">{t('admin.settings.platform.name')}</Label>
          <Input id="name" name="name" defaultValue={platform.name} maxLength={80} required />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="description">{t('admin.settings.platform.intro')}</Label>
          <Input
            id="description"
            name="description"
            defaultValue={platform.description}
            maxLength={280}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="url">{t('admin.settings.platform.url')}</Label>
          <Input
            id="url"
            name="url"
            type="url"
            defaultValue={platform.url ?? ''}
            placeholder="https://example.com"
          />
        </div>
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.ok && state.message ? (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        ) : null}
        <div>
          <Button type="submit" disabled={pending || isMutating}>
            {pending || isMutating ? t('admin.settings.saving') : t('admin.settings.platform.submit')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function BrandSettings({ brand }: { brand: BrandAssets | null }) {
  const router = useRouter();
  const t = useTranslator();
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    savePlatformBrandAction,
    {},
  );
  const [clearState, clearAction, clearPending] = useActionState<SettingsActionState, FormData>(
    async () => clearPlatformBrandAction(),
    {},
  );
  const [isMutating, startTransition] = useTransition();

  return (
    <section className="flex flex-col gap-5 rounded-lg border bg-card p-5 text-card-foreground shadow-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t('admin.settings.brand.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('admin.settings.brand.description')}
        </p>
      </div>
      <form
        action={(formData) => {
          startTransition(async () => {
            await action(formData);
            router.refresh();
          });
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-center gap-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={brand?.logoUrl ?? ''}
              alt={t('admin.settings.brand.currentLogo')}
              className="size-14 rounded-md border bg-background object-contain p-1"
            />
            <span className="text-xs text-muted-foreground">Logo</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={brand?.faviconUrl ?? ''}
              alt="Favicon"
              className="size-14 rounded-md border bg-background object-contain p-1"
            />
            <span className="text-xs text-muted-foreground">Favicon</span>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="brand-logo">{t('admin.settings.brand.uploadLogo')}</Label>
            <Input id="brand-logo" name="logo" type="file" accept="image/*" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="brand-favicon">{t('admin.settings.brand.uploadFavicon')}</Label>
            <Input id="brand-favicon" name="favicon" type="file" accept="image/*" />
          </div>
        </div>
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.ok && state.message ? (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        ) : null}
        <div>
          <Button type="submit" disabled={pending || isMutating}>
            {pending || isMutating ? t('admin.settings.saving') : t('admin.settings.brand.submit')}
          </Button>
        </div>
      </form>
      <form
        action={clearAction}
        className="flex flex-col gap-2"
        onSubmit={() => setTimeout(() => router.refresh(), 400)}
      >
        {clearState.error ? <p className="text-sm text-destructive">{clearState.error}</p> : null}
        {clearState.ok && clearState.message ? (
          <p className="text-sm text-muted-foreground">{clearState.message}</p>
        ) : null}
        <Button type="submit" variant="outline" disabled={clearPending} className="w-fit">
          {clearPending ? t('admin.settings.brand.resetting') : t('admin.settings.brand.reset')}
        </Button>
      </form>
    </section>
  );
}

function SigningSettings({ signing }: { signing: SigningStatus | null }) {
  const router = useRouter();
  const t = useTranslator();
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    saveSigningAction,
    {},
  );
  const [isMutating, startTransition] = useTransition();
  const envManaged = signing?.source === 'env';

  return (
    <section className="flex flex-col gap-5 rounded-lg border bg-card p-5 text-card-foreground shadow-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t('admin.settings.signing.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {envManaged
            ? t('admin.settings.signing.envManaged')
            : signing?.configured
              ? t('admin.settings.signing.configured', { fingerprint: signing.fingerprint ?? '' })
              : t('admin.settings.signing.unconfigured')}
        </p>
      </div>

      <form
        action={(formData) => {
          startTransition(async () => {
            await action(formData);
            router.refresh();
          });
        }}
        className="flex flex-col gap-3"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="publicKey">{t('admin.settings.signing.publicKey')}</Label>
          <textarea
            id="publicKey"
            name="publicKey"
            rows={7}
            defaultValue={signing?.publicKey ?? ''}
            disabled={envManaged}
            className="w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            placeholder="-----BEGIN PUBLIC KEY-----&#10;...&#10;-----END PUBLIC KEY-----"
          />
        </div>
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.ok && state.message ? (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending || isMutating || envManaged} className="w-fit">
            {pending || isMutating ? t('admin.settings.saving') : t('admin.settings.signing.submit')}
          </Button>
          {signing?.configured ? (
            <Button
              type="submit"
              name="clear"
              value="true"
              variant="outline"
              disabled={pending || isMutating || envManaged}
            >
              {t('admin.settings.signing.clear')}
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
