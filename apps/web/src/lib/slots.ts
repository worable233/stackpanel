import 'server-only';

import type { FrontendManifest, FrontendPackage, FrontendSettings } from '@stackpanel/sdk';
import { getApiClient, apiAssetUrl } from './api';
import { pinInSnapshot } from './frontend-snapshot';
import { getFrontendPackage } from './frontend-bundles';
import { loadRuntimeFrontend, runtimeFrontendLoadingEnabled } from './frontend-runtime';

export interface FrontendCandidate {
  kind: 'themes' | 'plugins';
  id: string;
  manifest: FrontendManifest;
  /**
   * Kernel-computed admission for server-side execution in the web process
   * (contract 03 §3.1). Themes ship with the image and are always admitted;
   * plugin candidates carry the kernel's decision. Absent (older API) is
   * treated as `declarative` so the gate is fail-closed.
   */
  serverExecution?: 'allowed' | 'declarative';
  /**
   * Active content-addressed revision (contract 04 §1), when the kernel exposes
   * it. Used to build versioned same-origin asset URLs so a request pins one
   * deployment version.
   */
  revision?: string;
}

export async function activeThemeCandidate(): Promise<FrontendCandidate | null> {
  // Contract 04 §3: resolve the active revision once per request, so every
  // consumer of a render (pages, layout, SEO, actions) sees one deployment.
  return pinInSnapshot('theme', () => resolveActiveThemeCandidate());
}

async function resolveActiveThemeCandidate(): Promise<FrontendCandidate | null> {
  try {
    const { theme } = await getApiClient().getActiveTheme();
    if (!theme) return null;
    const manifest = await getApiClient().getThemeFrontend(theme.id);
    if (!manifest.available || !manifest.manifest) return null;
    return {
      kind: 'themes',
      id: theme.id,
      manifest: manifest.manifest,
      ...(manifest.revision ? { revision: manifest.revision } : {}),
    };
  } catch {
    return null;
  }
}

/** Load a specific installed theme frontend candidate for preview rendering. */
export async function themeFrontendCandidate(themeId: string): Promise<FrontendCandidate | null> {
  // Preview pins an explicit theme. It shares the snapshot only when it is the
  // active theme; otherwise it resolves independently (previews are not the
  // deployment the rest of the request renders against).
  return resolveThemeCandidate(themeId);
}

async function resolveThemeCandidate(themeId: string): Promise<FrontendCandidate | null> {
  try {
    const descriptor = await getApiClient().getThemeFrontend(themeId);
    if (!descriptor.available || !descriptor.manifest) return null;
    return {
      kind: 'themes',
      id: themeId,
      manifest: descriptor.manifest,
      ...(descriptor.revision ? { revision: descriptor.revision } : {}),
    };
  } catch {
    return null;
  }
}

/** Discover every active plugin that contributes a compiled frontend package. */
export async function listPluginFrontendCandidates(): Promise<FrontendCandidate[]> {
  // Contract 04 §3: one plugin list (and thus one set of revisions) per request.
  return pinInSnapshot('plugins', resolvePluginFrontendCandidates);
}

async function resolvePluginFrontendCandidates(): Promise<FrontendCandidate[]> {
  try {
    const { plugins } = await getApiClient().getPluginFrontends();
    return plugins
      .filter((plugin) => plugin.manifest)
      .map((plugin) => ({
        kind: 'plugins' as const,
        id: plugin.id,
        manifest: plugin.manifest!,
        serverExecution: plugin.serverExecution,
        ...(plugin.revision ? { revision: plugin.revision } : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * Versioned same-origin base URL for a candidate's compiled assets
 * (contract 04 §2). Falls back to the unversioned base when the kernel has not
 * published a revision, so older deployments keep working.
 */
export function candidateAssetBase(candidate: FrontendCandidate): string {
  return candidate.revision
    ? apiAssetUrl(`/${candidate.kind}/${candidate.id}/frontend/${candidate.revision}`)
    : apiAssetUrl(`/${candidate.kind}/${candidate.id}/frontend`);
}

/**
 * Whether the server-execution trust gate is active (contract 03 §3.1).
 *
 * Default ON: third-party packages do **not** execute in the web process unless
 * the kernel admits them (`builtin` or the operator allowlist). Set
 * `STACKPANEL_FRONTEND_TRUST_GATE=0` to disable the gate (legacy behaviour: every
 * installed package may execute). The opt-out exists so a deployment can roll
 * back without a code change if a legitimate package is mis-classified.
 */
export function serverExecutionGateEnabled(): boolean {
  return process.env.STACKPANEL_FRONTEND_TRUST_GATE !== '0';
}

/**
 * Whether a candidate may execute server-side code (finders) in the web
 * process. Themes ship with the image and are always admitted; plugin
 * candidates use the kernel's `serverExecution` decision. Fail-closed: an
 * absent decision (older API) is treated as not admitted when the gate is on.
 */
export function candidateAdmitsServerExecution(candidate: FrontendCandidate): boolean {
  if (candidate.kind === 'themes') return true;
  if (!serverExecutionGateEnabled()) return true;
  return candidate.serverExecution === 'allowed';
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
 * Import a compiled frontend package.
 *
 * Two co-existing paths (stage 5 makes runtime loading the **default**):
 *
 * - **Runtime loading** (default; `STACKPANEL_FRONTEND_RUNTIME_LOAD=0` opts out): the
 *   host loads the package's compiled entry from the `data/` revision store at request
 *   time, so installing a theme/plugin no longer requires a `next build`. Host ABI is
 *   shared through the synchronous resolve hook (see `frontend-runtime.ts`).
 * - **Build-time registry** (`STACKPANEL_FRONTEND_RUNTIME_LOAD=0`): every package is
 *   statically imported into the generated registry so Next bundles them at build time.
 *   This is the reversible fallback; regenerate it with
 *   `STACKPANEL_FRONTEND_RUNTIME_LOAD=0 pnpm build:frontend`.
 *
 * In both cases the resolved value is validated against the manifest so a stale or
 * partial artifact is treated as "no package" rather than crashing a render.
 */
export async function importFrontendPackage(
  kind: 'themes' | 'plugins',
  id: string,
  manifest: FrontendManifest,
  revision?: string,
): Promise<FrontendPackage | null> {
  if (runtimeFrontendLoadingEnabled()) {
    const loaded = await loadRuntimeFrontend(kind, id, revision);
    if (loaded && isFrontendPackage(loaded, manifest)) return loaded as FrontendPackage;
  }
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
