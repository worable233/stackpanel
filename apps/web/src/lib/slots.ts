import 'server-only';

import type { FrontendManifest, FrontendPackage, FrontendSettings } from '@stackpanel/sdk';
import { getApiClient } from './api';
import { getFrontendPackage } from './frontend-bundles';

export interface FrontendCandidate {
  kind: 'themes' | 'plugins';
  id: string;
  manifest: FrontendManifest;
}

export async function activeThemeCandidate(): Promise<FrontendCandidate | null> {
  try {
    const { theme } = await getApiClient().getActiveTheme();
    if (!theme) return null;
    const manifest = await getApiClient().getThemeFrontend(theme.id);
    if (!manifest.available || !manifest.manifest) return null;
    return { kind: 'themes', id: theme.id, manifest: manifest.manifest };
  } catch {
    return null;
  }
}

/** Load a specific installed theme frontend candidate for preview rendering. */
export async function themeFrontendCandidate(themeId: string): Promise<FrontendCandidate | null> {
  try {
    const descriptor = await getApiClient().getThemeFrontend(themeId);
    if (!descriptor.available || !descriptor.manifest) return null;
    return { kind: 'themes', id: themeId, manifest: descriptor.manifest };
  } catch {
    return null;
  }
}

/** Discover every active plugin that contributes a compiled frontend package. */
export async function listPluginFrontendCandidates(): Promise<FrontendCandidate[]> {
  try {
    const { plugins } = await getApiClient().getPluginFrontends();
    return plugins
      .filter((plugin) => plugin.manifest)
      .map((plugin) => ({ kind: 'plugins' as const, id: plugin.id, manifest: plugin.manifest! }));
  } catch {
    return [];
  }
}

export async function readThemeSettings(id: string): Promise<FrontendSettings> {
  try {
    return (await getApiClient().getThemeSettings(id)).settings;
  } catch {
    return {};
  }
}

export async function readPluginSettings(id: string): Promise<FrontendSettings> {
  try {
    return (await getApiClient().getPluginSettings(id)).settings;
  } catch {
    return {};
  }
}

/**
 * Import a compiled frontend package from the generated registry.
 *
 * All frontend packages (built-in or third-party) are imported through the
 * generated registry so Next.js can bundle them at build time. This guarantees
 * every package shares the same React instance and avoids the runtime `import()`
 * of a file URL, which would load a second copy of React and break hooks.
 */
export async function importFrontendPackage(
  kind: 'themes' | 'plugins',
  id: string,
  manifest: FrontendManifest,
): Promise<FrontendPackage | null> {
  const pkg = getFrontendPackage(kind, id);
  if (!pkg || !isFrontendPackage(pkg, manifest)) return null;
  return pkg;
}

function isFrontendPackage(value: unknown, manifest: FrontendManifest): value is FrontendPackage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (manifest.pages.length > 0 && !isRecord(candidate['pageComponents'])) return false;
  if (manifest.layouts.length > 0 && !isRecord(candidate['layouts'])) return false;
  if (manifest.finders.length > 0 && !isRecord(candidate['finders'])) return false;
  const hasUiSurface =
    manifest.adminRoutes.length > 0 ||
    manifest.adminActions.length > 0 ||
    manifest.actions.length > 0 ||
    manifest.accountRoutes.length > 0 ||
    manifest.accountWidgets.length > 0;
  return !hasUiSurface || isRecord(candidate['ui']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
