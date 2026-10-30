'use client';
import { NotificationPolicySettings } from '@/components/notification-settings';
import { CurrencySettings } from '@/components/currency-settings';
import { PaymentMethodSettings } from '@/components/payment-method-settings';
import { DistributionSourceSettings } from '@/components/distribution-source-settings';
import { UpdatePolicySettings } from '@/components/update-policy-settings';
import { AgentSettings } from '@/components/agent-settings';
import { SectionTitle } from '@stackpanel/ui';

import { useActionState, useTransition, type ReactNode } from 'react';
import { SettingsSections } from '@/components/settings-sections';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  AdminCurrencyDefinitionView,
  AdminFxRateView,
  AdminSalesChannel,
  AdminSalesChannelListResponse,
  DistributionSourceConfig,
  PlatformInfo,
  SettlementCurrencyResponse,
  SigningStatus,
  UpdatePolicyView,
} from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  pluginSections?: { id: string; title: string; content: ReactNode }[];
}) {
  const t = useTranslator();
  const sections = [
    {
      id: 'platform',
      title: t('admin.settings.platform.title'),
      Icon: Settings,
      content: <PlatformInfoSettings platform={platform} />,
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

function PlatformInfoSettings({ platform }: { platform: PlatformInfo }) {
  const router = useRouter();
  const t = useTranslator();
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    savePlatformInfoAction,
    {},
  );
  const [isMutating, startTransition] = useTransition();

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
