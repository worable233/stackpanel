import { apiAssetUrl } from './api';

export interface FrontendStyleLink {
  key: string;
  href: string;
  marker: string;
  revision?: string;
}

interface FrontendStyleSource {
  styles?: string[];
  entry?: string;
}

export interface ThemeStyleSource {
  id: string;
  descriptor: { available: boolean; manifest: FrontendStyleSource | null; revision?: string };
}

export interface PluginStyleSource {
  id: string;
  manifest: FrontendStyleSource | null;
  revision?: string;
}

/**
 * Contract 05 §3.6/§3.8 — compute the deterministic, same-origin `<link>` set.
 *
 * Split out from the server component so the URL shape (especially the binding
 * of a `styles[]` entry to its revision directory) is unit-testable.
 *
 * A `styles[]` entry is a path relative to the **frontend package root**
 * (e.g. `frontend/dist/x.css`). The versioned route serves the revision
 * directory contents *without* the `frontend/` prefix (`<rev>/dist/x.css`), and
 * the flat route serves them without it too (`frontend/dist/x.css`). Stripping
 * only the leading `frontend/` keeps both bases consistent.
 */
export function buildFrontendStyleLinks(
  theme: ThemeStyleSource | null,
  plugins: PluginStyleSource[],
): FrontendStyleLink[] {
  const links: FrontendStyleLink[] = [];

  if (theme) {
    links.push({
      key: `theme-css:${theme.id}`,
      href: apiAssetUrl(`/themes/${theme.id}/theme.css`),
      marker: `themes:${theme.id}`,
    });
    const descriptor = theme.descriptor;
    if (descriptor.available && descriptor.manifest) {
      const base = descriptor.revision
        ? apiAssetUrl(`/themes/${theme.id}/frontend/${descriptor.revision}`)
        : apiAssetUrl(`/themes/${theme.id}/frontend`);
      for (const style of descriptor.manifest.styles ?? []) {
        const asset = style.replace(/^frontend\//, '');
        links.push({
          key: `theme-style:${theme.id}:${style}`,
          href: `${base}/${asset}`,
          marker: `themes:${theme.id}`,
          ...(descriptor.revision ? { revision: descriptor.revision } : {}),
        });
      }
    }
  }

  for (const plugin of plugins) {
    const styles = plugin.manifest?.styles ?? [];
    if (styles.length === 0) continue;
    const base = plugin.revision
      ? apiAssetUrl(`/plugins/${plugin.id}/frontend/${plugin.revision}`)
      : apiAssetUrl(`/plugins/${plugin.id}/frontend`);
    for (const style of styles) {
      const asset = style.replace(/^frontend\//, '');
      links.push({
        key: `plugin-style:${plugin.id}:${style}`,
        href: `${base}/${asset}`,
        marker: `plugins:${plugin.id}`,
        ...(plugin.revision ? { revision: plugin.revision } : {}),
      });
    }
  }

  return links;
}
