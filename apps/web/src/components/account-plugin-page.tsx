import { createElement } from 'react';
import type { ReactElement } from 'react';
import type { AccountPageComponentProps, AccountUser } from '@stackpanel/sdk';
import type { PluginAccountRouteResult } from '@/lib/account-frontend';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

/** Render a resolved plugin account page without exposing transport errors. */
export async function AccountPluginPage({
  pluginId,
  path,
  user,
  result,
  searchParams,
  actionError,
}: {
  pluginId: string;
  path: string;
  user: AccountUser;
  result: PluginAccountRouteResult;
  searchParams?: Record<string, string>;
  actionError?: string;
}): Promise<ReactElement> {
  const t = createTranslator(await getLocale());
  if (result.status === 'not-found') {
    return <p className="text-sm text-muted-foreground">{t('account.page.notFound')}</p>;
  }
  if (result.status === 'denied') {
    return <p className="text-sm text-destructive">{t('account.page.denied')}</p>;
  }
  const Component = result.component;
  return (
    <div className="space-y-6">
      {actionError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </p>
      ) : null}
      {createElement(Component, {
        pluginId,
        path,
        params: result.params,
        searchParams: searchParams ?? {},
        settings: result.settings,
        data: result.data,
        user,
        actions: result.actions,
      } as AccountPageComponentProps)}
    </div>
  );
}
