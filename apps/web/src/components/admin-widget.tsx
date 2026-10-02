import { createElement } from 'react';
import type { ComponentType, ReactElement } from 'react';
import type { AdminWidgetProps } from '@stackpanel/sdk';
import { importFrontendPackage } from '@/lib/slots';

/** Render a plugin-provided admin dashboard widget from its frontend package. */
export async function AdminWidget({
  pluginId,
  widgetId,
}: {
  pluginId: string;
  widgetId: string;
}): Promise<ReactElement | null> {
  const manifest = await getPluginManifest(pluginId);
  if (!manifest) return null;
  const pkg = await importFrontendPackage('plugins', pluginId, manifest);
  const widget = pkg?.ui?.adminWidgets?.[widgetId];
  if (!widget) return null;
  const TypedWidget = widget as unknown as ComponentType<AdminWidgetProps>;
  return createElement(TypedWidget, { pluginId }) as ReactElement;
}

/** Fetch the frontend manifest for a plugin from the API. */
async function getPluginManifest(pluginId: string) {
  const { listPluginFrontendCandidates } = await import('@/lib/slots');
  const candidates = await listPluginFrontendCandidates();
  return candidates.find((candidate) => candidate.id === pluginId)?.manifest ?? null;
}
