import { createElement } from 'react';
import type { ReactElement } from 'react';
import type { AccountPageComponentProps, AccountUser } from '@stackpanel/sdk';
import type { PluginAccountRouteResult } from '@/lib/account-frontend';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { FrontendScopeRoot } from './frontend-scope';
import { PluginFrontendBroken } from './plugin-frontend-broken';
import { enterFrontendContext } from '@/lib/frontend-runtime-diagnostics';

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
  if (result.status === 'broken') {
    return <PluginFrontendBroken pluginId={result.pluginId} reason={result.reason} />;
  }
  const Component = result.component;
  // 诊断上下文（P1-B）：这之后任何来自 ABI 桩 / loader 的日志都能带上
  // 插件 id 与路由，而不是只有一句 `[frontend-runtime]`。
  // 实测辇因在根因：线上 v0.1.3 实例详情页 500 只能靠手工 grep 编译产物反查。
  enterFrontendContext({
    kind: 'plugins',
    id: pluginId,
    route: path,
  });
  return (
    <FrontendScopeRoot scope={`plugins:${pluginId}`} className="plugin-admin flex flex-col gap-6">
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
