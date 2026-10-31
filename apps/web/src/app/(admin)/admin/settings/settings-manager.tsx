'use client';
import { NotificationPolicySettings } from '@/components/notification-settings';
import { CurrencySettings } from '@/components/currency-settings';
import { PaymentMethodSettings } from '@/components/payment-method-settings';
import { DistributionSourceSettings } from '@/components/distribution-source-settings';
import { UpdatePolicySettings } from '@/components/update-policy-settings';
import { AgentSettings } from '@/components/agent-settings';
import { RuntimeConfigSettings } from '@/components/runtime-config-settings';
import { SectionTitle } from '@stackpanel/ui';

import { useActionState, useId, useState, useTransition, type ReactNode } from 'react';
import { SettingsSections } from '@/components/settings-sections';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  AdminCurrencyDefinitionView,
  AdminFxRateView,
  AdminRuntimeConfigEntry,
  AdminSalesChannel,
  AdminSalesChannelListResponse,
  DistributionSourceConfig,
  PlatformBrandDisplay,
  PlatformInfo,
  SettlementCurrencyResponse,
  SigningStatus,
  UpdatePolicyView,
} from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Settings,
  Palette,
  ShieldCheck,
  Wrench,
  ImageIcon,
  Bot,
  Plug,
  Bell,
  Coins,
  CreditCard,
  Download,
  ArrowUpCircle,
  SlidersHorizontal,
  PanelsTopLeft,
} from 'lucide-react';
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
  currency,
  currencyRates = [],
  distribution,
  distributionDefaults,
  updatePolicy,
  salesChannels = [],
  paymentProviders = [],
  runtimeConfig = [],
  pluginSections = [],
}: {
  platform: PlatformInfo;
  signing: SigningStatus | null;
  brand: BrandAssets | null;
  currency?: (SettlementCurrencyResponse & { currencies?: AdminCurrencyDefinitionView[] }) | null;
  currencyRates?: AdminFxRateView[];
  distribution?: DistributionSourceConfig | null;
  distributionDefaults?: { repository: string | null; mirror: string | null } | undefined;
  updatePolicy?: UpdatePolicyView | null;
  salesChannels?: AdminSalesChannel[];
  paymentProviders?: NonNullable<AdminSalesChannelListResponse['providers']>;
  runtimeConfig?: AdminRuntimeConfigEntry[];
  pluginSections?: { id: string; title: string; content: ReactNode }[];
}) {
  const t = useTranslator();
  const sections = [
    {
      id: 'platform',
      title: t('admin.settings.platform.title'),
      Icon: Settings,
      content: <PlatformInfoSettings platform={platform} brand={brand} />,
    },
    {
      id: 'brand',
      title: t('admin.settings.brand.title'),
      Icon: Palette,
      content: <BrandSettings brand={brand} />,
    },
    {
      id: 'signing',
      title: t('admin.settings.signing.title'),
      Icon: ShieldCheck,
      content: <SigningSettings signing={signing} />,
    },
    ...(distribution
      ? [
          {
            id: 'distribution',
            title: t('admin.settings.distribution.title'),
            Icon: Download,
            content: (
              <DistributionSourceSettings source={distribution} defaults={distributionDefaults} />
            ),
          },
        ]
      : []),
    ...(updatePolicy
      ? [
          {
            id: 'updates',
            title: t('admin.settings.updates.title'),
            Icon: ArrowUpCircle,
            content: <UpdatePolicySettings policy={updatePolicy} />,
          },
        ]
      : []),
    ...(currency
      ? [
          {
            id: 'currency',
            title: t('admin.settings.currency.title'),
            Icon: Coins,
            content: <CurrencySettings catalog={currency} rates={currencyRates} />,
          },
        ]
      : []),
    {
      id: 'payment',
      title: t('admin.settings.payment.title'),
      Icon: CreditCard,
      content: <PaymentMethodSettings channels={salesChannels} providers={paymentProviders} />,
    },
    {
      id: 'agent',
      title: 'Agent',
      Icon: Bot,
      content: <AgentSettings />,
    },
    {
      id: 'notifications',
      title: t('notificationSettings.policy'),
      Icon: Bell,
      content: <NotificationPolicySettings />,
    },
    ...(runtimeConfig.length > 0
      ? [
          {
            id: 'runtime',
            title: t('admin.settings.runtimeConfig.title'),
            Icon: SlidersHorizontal,
            content: <RuntimeConfigSettings entries={runtimeConfig} />,
          },
        ]
      : []),
    ...pluginSections.map((section) => ({ ...section, Icon: Plug })),
    {
      id: 'advanced',
      title: t('admin.settings.advanced.title'),
      Icon: Wrench,
      content: <AdvancedSettings />,
    },
  ];

  return <SettingsSections sections={sections} label={t('admin.settings.title')} />;
}

function PlatformInfoSettings({
  platform,
  brand,
}: {
  platform: PlatformInfo;
  brand: BrandAssets | null;
}) {
  const router = useRouter();
  const t = useTranslator();
  const id = useId();
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    savePlatformInfoAction,
    {},
  );
  const [isMutating, startTransition] = useTransition();
  const [name, setName] = useState(platform.name);
  const [brandDisplay, setBrandDisplay] = useState<PlatformBrandDisplay>(
    platform.brandDisplay ?? 'both',
  );
  const brandOptions: { value: PlatformBrandDisplay; label: string; hint: string }[] = [
    {
      value: 'icon',
      label: t('admin.settings.platform.brandDisplayIcon'),
      hint: t('admin.settings.platform.brandDisplayIconHint'),
    },
    {
      value: 'name',
      label: t('admin.settings.platform.brandDisplayName'),
      hint: t('admin.settings.platform.brandDisplayNameHint'),
    },
    {
      value: 'both',
      label: t('admin.settings.platform.brandDisplayBoth'),
      hint: t('admin.settings.platform.brandDisplayBothHint'),
    },
  ];

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 pb-2">
        <SectionTitle>{t('admin.settings.platform.title')}</SectionTitle>
        <p className="text-sm text-muted-foreground">{t('admin.settings.platform.description')}</p>
      </div>
      <form
        action={(formData) => {
          startTransition(async () => {
            await action(formData);
            router.refresh();
          });
        }}
        className="flex flex-col gap-6"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">{t('admin.settings.platform.name')}</Label>
          <Input
            id="name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
          />
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
        <div className="flex flex-col gap-2">
          <span id={`${id}-brand-display`} className="text-sm font-medium">
            {t('admin.settings.platform.brandDisplay')}
          </span>
          <p className="text-sm text-muted-foreground">
            {t('admin.settings.platform.brandDisplayDescription')}
          </p>
          <input type="hidden" name="brandDisplay" value={brandDisplay} />
          <div className="mt-2 rounded-2xl bg-muted/35 p-3.5">
            <div className="flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
              <span>{t('admin.settings.platform.brandPreview')}</span>
              <span className="truncate">{t('admin.settings.platform.brandPreviewHint')}</span>
            </div>
            <div className="mt-2.5 flex min-h-16 items-center rounded-xl bg-background px-4 py-3">
              <span className="flex min-w-0 items-center gap-2.5">
                {brandDisplay !== 'name' ? (
                  brand?.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={brand.logoUrl}
                      alt=""
                      className="size-8 shrink-0 rounded-lg object-contain"
                    />
                  ) : (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
                      <PanelsTopLeft className="size-4" aria-hidden="true" />
                    </span>
                  )
                ) : null}
                {brandDisplay !== 'icon' ? (
                  <span className="truncate text-lg font-medium tracking-tight">
                    {name.trim() || platform.name}
                  </span>
                ) : null}
              </span>
            </div>
          </div>
          <RadioGroup
            value={brandDisplay}
            onValueChange={(value) => setBrandDisplay(value as PlatformBrandDisplay)}
            aria-labelledby={`${id}-brand-display`}
            className="mt-1 grid gap-2 sm:grid-cols-3"
          >
            {brandOptions.map((option) => (
              <label
                key={option.value}
                htmlFor={`${id}-${option.value}`}
                className={
                  brandDisplay === option.value
                    ? 'flex cursor-pointer flex-col gap-1 rounded-xl bg-muted/60 p-4 transition-colors'
                    : 'flex cursor-pointer flex-col gap-1 rounded-xl bg-muted/30 p-4 transition-colors hover:bg-muted/45'
                }
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <RadioGroupItem id={`${id}-${option.value}`} value={option.value} />
                  {option.label}
                </span>
                <span className="pl-6 text-xs leading-5 text-muted-foreground">
                  {option.hint}
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.ok && state.message ? (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        ) : null}
        <div>
          <Button type="submit" disabled={pending || isMutating}>
            {pending || isMutating
              ? t('admin.settings.saving')
              : t('admin.settings.platform.submit')}
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
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 pb-2">
        <SectionTitle>{t('admin.settings.brand.title')}</SectionTitle>
        <p className="text-sm text-muted-foreground">{t('admin.settings.brand.description')}</p>
      </div>
      <form
        action={(formData) => {
          startTransition(async () => {
            await action(formData);
            router.refresh();
          });
        }}
        className="flex flex-col gap-6"
      >
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-center gap-1.5">
            <div className="flex size-16 items-center justify-center rounded-md border bg-muted/30 p-2">
              {brand?.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={brand.logoUrl}
                  alt={t('admin.settings.brand.currentLogo')}
                  className="size-full object-contain"
                />
              ) : (
                <ImageIcon className="size-5 text-muted-foreground" />
              )}
            </div>
            <span className="text-xs text-muted-foreground">Logo</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <div className="flex size-16 items-center justify-center rounded-md border bg-muted/30 p-2">
              {brand?.faviconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brand.faviconUrl} alt="Favicon" className="size-full object-contain" />
              ) : (
                <ImageIcon className="size-5 text-muted-foreground" />
              )}
            </div>
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
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 pb-2">
        <SectionTitle>{t('admin.settings.signing.title')}</SectionTitle>
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
        className="flex flex-col gap-6"
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
            {pending || isMutating
              ? t('admin.settings.saving')
              : t('admin.settings.signing.submit')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function AdvancedSettings() {
  const t = useTranslator();

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 pb-2">
        <SectionTitle>{t('admin.settings.advanced.title')}</SectionTitle>
        <p className="text-sm text-muted-foreground">{t('admin.settings.advanced.description')}</p>
      </div>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="flex flex-col gap-1 pb-2">
          <h3 className="text-sm font-medium">
            {t('admin.settings.advanced.developerConsoleTitle')}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t('admin.settings.advanced.developerConsoleDescription')}
          </p>
        </div>
        <Button
          render={<Link href="/admin/developer" />}
          variant="outline"
          size="sm"
          className="shrink-0"
        >
          {t('admin.settings.advanced.developerConsoleOpen')}
        </Button>
      </div>
    </section>
  );
}
