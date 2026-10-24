import { createElement } from 'react';
import type { ReactElement } from 'react';
import type { AccountPageComponentProps, AccountUser } from '@stackpanel/sdk';
import type { PluginAccountRouteResult } from '@/lib/account-frontend';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { FrontendScopeRoot } from './frontend-scope';

/** Render a resolved plugin account page without exposing transport errors. */
export async function AccountPluginPage({
  pluginId,
  path,
  user,
  result,
  searchParams,
}: {
  pluginId: string;
  path: string;
  user: AccountUser;
  result: PluginAccountRouteResult;
  searchParams?: Record<string, string>;
}): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);
  if (result.status === 'not-found') {
    return <p className="text-sm text-muted-foreground">{t('account.page.notFound')}</p>;
  }
  if (result.status === 'denied') {
    return <p className="text-sm text-destructive">{t('account.page.denied')}</p>;
  }
  const Component = result.component;
  return (
    <FrontendScopeRoot scope={`plugins:${pluginId}`} className="block space-y-6">
      {/* Action feedback is toasted globally; an inline copy would duplicate it. */}
      {createElement(Component, {
        pluginId,
        path,
        params: result.params,
        searchParams: searchParams ?? {},
        settings: result.settings,
        data: result.data,
        user,
        actions: result.actions,
        locale,
      } as AccountPageComponentProps)}
    </FrontendScopeRoot>
  );
}
