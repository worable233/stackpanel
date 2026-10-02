'use client';

import { useActionState } from 'react';
import { useRouter } from 'next/navigation';
import type { MarketPackage } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import {
  installMarketPluginAction,
  installMarketThemeAction,
  type MarketActionState,
} from '@/lib/market-actions';
import { useTranslator } from '@/i18n/provider';
import type { Translator } from '@/i18n/core';

function StatusBadge({ pkg, t }: { pkg: MarketPackage; t: Translator }) {
  if (pkg.installed && pkg.current) {
    return (
      <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
        {t('market.installed')}
      </span>
    );
  }
  if (pkg.installed && pkg.upgradable) {
    return (
      <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning">
        {t('market.upgradableTo', { version: pkg.version })}
      </span>
    );
  }
  if (pkg.installed) {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        {t('market.installedDifferent')}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      {t('market.notInstalled')}
    </span>
  );
}

/** One installable package row with a one-click install/upgrade action. */
function MarketRow({ pkg }: { pkg: MarketPackage }) {
  const router = useRouter();
  const t = useTranslator();
  const action = pkg.kind === 'plugin' ? installMarketPluginAction : installMarketThemeAction;
  const [state, formAction, pending] = useActionState<MarketActionState, FormData>(action, {});
  const installLabel = pkg.installed
    ? pkg.upgradable
      ? t('market.upgradeTo', { version: pkg.version })
      : t('market.reinstall')
    : t('market.install');

  return (
    <li className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{pkg.name}</p>
          <StatusBadge pkg={pkg} t={t} />
          {pkg.builtin ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t('market.builtin')}
            </span>
          ) : null}
        </div>
        {pkg.description ? (
          <p className="mt-1 text-sm text-muted-foreground">{pkg.description}</p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {pkg.id} · v{pkg.version}
          {pkg.frontend?.available
            ? ` · ${t('market.frontendPages', { count: pkg.frontend.pages.length })}`
            : ''}
        </p>
        {state.error ? <p className="mt-2 text-sm text-destructive">{state.error}</p> : null}
        {state.ok ? <p className="mt-2 text-sm text-success">{state.message}</p> : null}
      </div>
      <form
        action={async (formData) => {
          formData.set('id', pkg.id);
          await formAction(formData);
          router.refresh();
        }}
        className="shrink-0"
      >
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? t('market.installing') : installLabel}
        </Button>
      </form>
    </li>
  );
}

/** Market section listing packages of one kind. */
export function MarketSection({ title, packages }: { title: string; packages: MarketPackage[] }) {
  const t = useTranslator();
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      {packages.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {packages.map((pkg) => (
            <MarketRow key={`${pkg.kind}-${pkg.id}`} pkg={pkg} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">{t('market.empty')}</p>
      )}
    </section>
  );
}
