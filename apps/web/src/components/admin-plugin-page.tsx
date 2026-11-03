'use client';

import { createElement } from 'react';
import type { ReactElement } from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import type { PluginAdminRouteResult } from '@/lib/admin-frontend';
import { getClientAdminPages } from '@/lib/frontend-client-registry';
import { RuntimeAdminPage } from './runtime-admin-page';
import { PluginFrontendBroken } from './plugin-frontend-broken';
import { FrontendScopeRoot } from './frontend-scope';
import { wrapPluginActions } from '@/lib/plugin-action-client';
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
  embedded = false,
}: {
  pluginId: string;
  path: string;
  result: PluginAdminRouteResult;
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
  if (result.status === 'broken') {
    return (
      <main className="mx-auto w-full max-w-3xl">
        <PluginFrontendBroken pluginId={result.pluginId} reason={result.reason} />
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
          ...(result.dataErrors ? { dataErrors: result.dataErrors } : {}),
          actions: result.actions as unknown as Record<string, unknown>,
          params: result.params,
        }}
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
    ...(result.dataErrors ? { dataErrors: result.dataErrors } : {}),
    // Same wrapping as the runtime-loading path: one host-side toast, and the
    // page still gets `{ ok, error }` back from the action it awaits.
    actions: wrapPluginActions(result.actions, t),
    locale,
  } as AdminPageComponentProps;
  return (
    <FrontendScopeRoot
      scope={`plugins:${result.pluginId}`}
      className="plugin-admin flex flex-col gap-6"
    >
      {createElement(Component, props as never) as unknown as ReactElement}
    </FrontendScopeRoot>
  );
}
