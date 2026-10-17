import { getApiClient } from '@/lib/api';
import {
  buildFrontendStyleLinks,
  type PluginStyleSource,
  type ThemeStyleSource,
} from '@/lib/frontend-style-links';
import FrontendStyleLinks from '@/components/frontend-style-links';

/**
 * Contract 05 §3.6/§3.8 — the single controlled `<link>` injection point.
 *
 * Computes, in a deterministic order:
 *   1. the active theme's token stylesheet (`theme.css`, restricted channel), and
 *   2. every active frontend package's pre-compiled `styles[]` (contract 05 §3.2),
 *      addressed through the **versioned** revision base (contract 04 §2).
 *
 * All URLs are same-origin (via `apiAssetUrl`) so they satisfy the CSP
 * `style-src 'self'` policy (contract 05 §5) — third-party CSS never relies on
 * `'unsafe-inline'` and is never `@import`ed by the host.
 *
 * Every `<link>` carries a stable `data-sp-style` marker (`<kind>:<id>`) and,
 * for versioned stylesheets, `data-sp-revision`. React reconciliation drops links
 * whose package (or revision) is no longer present, so switching theme/plugin
 * removes the old `<link>` without leaving stale rules (contract 05 §3.6). The
 * client half (`frontend-style-links.tsx`) additionally drops any link that
 * fails to load (contract 06 §1.3).
 */
export default async function FrontendStylesheets() {
  const client = getApiClient();
  let theme: ThemeStyleSource | null = null;
  const plugins: PluginStyleSource[] = [];

  // 1. Active theme: token channel + its own styles[].
  try {
    const active = await client.getActiveTheme();
    if (active.theme) {
      const descriptor = await client.getThemeFrontend(active.theme.id);
      theme = {
        id: active.theme.id,
        descriptor: {
          available: descriptor.available,
          manifest: descriptor.manifest,
          ...(descriptor.revision ? { revision: descriptor.revision } : {}),
        },
      };
    }
  } catch {
    // A missing active theme degrades to host-only styling (contract 06 §4).
  }

  // 2. Active plugin frontends' styles[].
  try {
    const { plugins: frontends } = await client.getPluginFrontends();
    for (const plugin of frontends) {
      plugins.push({
        id: plugin.id,
        manifest: plugin.manifest,
        ...(plugin.revision ? { revision: plugin.revision } : {}),
      });
    }
  } catch {
    // Plugin style discovery is best-effort; page rendering already tolerates it.
  }

  return <FrontendStyleLinks links={buildFrontendStyleLinks(theme, plugins)} />;
}
