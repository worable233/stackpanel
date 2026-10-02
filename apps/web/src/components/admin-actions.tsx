import 'server-only';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import type { AdminActionComponentProps } from '@stackpanel/sdk';
import { getAuthedApiClient } from '@/lib/api';
import { importFrontendPackage, listPluginFrontendCandidates } from '@/lib/slots';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

interface VisibleAction {
  id: string;
  label: string;
  component: string;
  pluginId: string;
}

async function visibleActions(pluginId?: string): Promise<VisibleAction[]> {
  try {
    const api = await getAuthedApiClient();
    const actions = (await api.getAdminActions()).actions.filter(
      (action) => pluginId === undefined || action.pluginId === pluginId,
    );
    const allowed = await Promise.all(
      actions.map((action) =>
        action.permission
          ? api
              .checkPermission(action.permission)
              .then((check) => check.allowed)
              .catch(() => false)
          : Promise.resolve(true),
      ),
    );
    return actions
      .filter((_, index) => allowed[index])
      .map((action) => ({
        id: action.id,
        label: action.label,
        component: action.component,
        pluginId: action.pluginId,
      }));
  } catch {
    return [];
  }
}

/** Render admin actions contributed by one plugin frontend package. */
export async function AdminActions({
  pluginId,
}: {
  pluginId: string;
}): Promise<ReactElement | null> {
  const actions = await visibleActions(pluginId);
  if (actions.length === 0) return null;

  const t = createTranslator(await getLocale());
  const candidate = (await listPluginFrontendCandidates()).find((item) => item.id === pluginId);
  const pkg = candidate
    ? await importFrontendPackage('plugins', pluginId, candidate.manifest)
    : null;
  return (
    <section className="mt-6 rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="text-sm font-semibold">{t('admin.pluginActions')}</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {actions.map((action) => {
          const Component = pkg?.ui?.adminActionComponents?.[action.component];
          if (Component) {
            return createElement(Component, { pluginId } as AdminActionComponentProps, null);
          }
          return (
            <span
              key={action.id}
              className="inline-flex h-8 items-center rounded-md border px-3 text-xs text-muted-foreground"
            >
              {action.label}
            </span>
          );
        })}
      </div>
    </section>
  );
}

/** Render all active plugin admin actions inside the plugin management page. */
export async function AdminActionsOverview(): Promise<ReactElement | null> {
  const actions = await visibleActions();
  if (actions.length === 0) return null;
  const t = createTranslator(await getLocale());
  const byPlugin = new Map<string, VisibleAction[]>();
  for (const action of actions) {
    const items = byPlugin.get(action.pluginId) ?? [];
    items.push(action);
    byPlugin.set(action.pluginId, items);
  }
  const pluginNames = new Map<string, string>();
  try {
    const api = await getAuthedApiClient();
    const result = await api.getAdminPlugins();
    for (const plugin of result.plugins) {
      pluginNames.set(plugin.id, plugin.name);
    }
  } catch {
    // Keep the rendered links even if the names lookup fails.
  }

  return (
    <section className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="text-sm font-semibold">{t('admin.pluginActions')}</h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[...byPlugin.entries()].map(([pluginId, items]) => (
          <div key={pluginId} className="space-y-2">
            <a
              href={`/admin/plugin/${encodeURIComponent(pluginId)}`}
              className="text-sm font-medium hover:underline"
            >
              {pluginNames.get(pluginId) ?? pluginId}
            </a>
            <div className="flex flex-wrap gap-2">
              {items.map((action) => (
                <a
                  key={action.id}
                  href={`/admin/plugin/${encodeURIComponent(pluginId)}`}
                  className="inline-flex h-8 items-center rounded-md border bg-background px-3 text-xs text-card-foreground hover:bg-accent"
                >
                  {action.label}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
