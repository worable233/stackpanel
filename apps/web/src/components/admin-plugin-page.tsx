'use client';

import { createElement } from 'react';
import type { ReactElement } from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import type { PluginAdminRouteResult } from '@/lib/admin-frontend';
import { getClientAdminPages } from '@/lib/frontend-client-registry';
import { useTranslator } from '@/i18n/provider';

/** Render the result of a plugin admin route resolution on the client. */
export function AdminPluginPage({
  path,
  result,
  actionError,
}: {
  pluginId: string;
  path: string;
  result: PluginAdminRouteResult;
  actionError?: string;
}): ReactElement {
  const t = useTranslator();
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
    pluginId: result.pluginId,
    path,
    params: result.params,
    settings: result.settings,
    data: result.data,
    actions: result.actions,
  } as AdminPageComponentProps;
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
      {createElement(Component, props as never) as ReactElement}
    </div>
  );
}
