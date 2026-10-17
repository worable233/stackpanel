'use client';

import { createElement } from 'react';
import type { ReactElement } from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import type { PluginAdminRouteResult } from '@/lib/admin-frontend';
import { getClientAdminPages } from '@/lib/frontend-client-registry';
import { RuntimeAdminPage } from './runtime-admin-page';
import { FrontendScopeRoot } from './frontend-scope';
import { useLocale, useTranslator } from '@/i18n/provider';

/**
 * Render the result of a plugin admin route resolution on the client.
 *
 * Stage 5 has two co-existing client paths (the server sets `runtimeAdminModuleUrl`
 * on the result when runtime loading is enabled — the **default**; opt out with
 * `STACKPANEL_FRONTEND_RUNTIME_LOAD=0`):
 *
 * - **Runtime loading** (default): `RuntimeAdminPage` dynamically imports the plugin's
 *   compiled admin entry at request time (host ABI via the controlled adapter).
 * - **Build-time registry** (`STACKPANEL_FRONTEND_RUNTIME_LOAD=0`): the plugin's admin
 *   entry was statically imported by the generated client registry and is looked up
 *   synchronously.
 */
export function AdminPluginPage({
  path,
  result,
  actionError,
  embedded = false,
}: {
  pluginId: string;
  path: string;
  result: PluginAdminRouteResult;
  actionError?: string;
  embedded?: boolean;
}): ReactElement {
  const t = useTranslator();
  const locale = useLocale();
  if (result.status === 'not-found') {
    return (
      <main className="mx-auto w-full max-w-3xl">
        <p className="text-sm text-muted-foreground">{t('pluginPage.notFound')}</p>
      </main>
    );
  }
  if (result.status === 'denied') {
    return (
      <main className="mx-auto w-full max-w-3xl">
        <p className="text-sm text-destructive">
          {t('pluginPage.denied', { permission: result.permission })}
        </p>
      </main>
    );
  }
  if (result.runtimeAdminModuleUrl) {
    return (
      <RuntimeAdminPage
        moduleUrl={result.runtimeAdminModuleUrl}
        result={{
          pluginId: result.pluginId,
          path,
          componentId: result.componentId,
          settings: result.settings as unknown as Record<string, unknown>,
          data: result.data,
          actions: result.actions as unknown as Record<string, unknown>,
          params: result.params,
        }}
        actionError={actionError}
      />
    );
  }
  const adminPages = getClientAdminPages('plugins', result.pluginId);
  const Component = adminPages?.[result.componentId];
  if (!Component) {
    return (
      <main className="mx-auto w-full max-w-3xl">
        <p className="text-sm text-muted-foreground">{t('pluginPage.notFound')}</p>
      </main>
    );
  }
  const props = {
    embedded,
    pluginId: result.pluginId,
    path,
    params: result.params,
    settings: result.settings,
    data: result.data,
    actions: result.actions,
    locale,
  } as AdminPageComponentProps;
  return (
    <FrontendScopeRoot scope={`plugins:${result.pluginId}`} className="block space-y-6">
      {actionError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </p>
      ) : null}
      {createElement(Component, props as never) as unknown as ReactElement}
    </FrontendScopeRoot>
  );
}
