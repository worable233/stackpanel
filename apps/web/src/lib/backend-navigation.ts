/** Navigation is composed only from authorized kernel routes and active plugin declarations. */
export interface BackendNavigationItem {
  href: string;
  label: string;
  group?: string;
  pluginId?: string;
  order?: number;
  activePaths?: string[];
  /**
   * Explicit "this route is the plugin's overview" marker. Preferred over
   * label matching: labels are localized, so any label-based heuristic breaks
   * as soon as the interface language changes (ADR-0016).
   */
  overview?: boolean;
}

/** Normalize only declared overview entries; never infer or create plugin routes. */
export function isBackendOverview(item: BackendNavigationItem): boolean {
  if (item.overview === true) return true;
  // Legacy fallback for packages published before the `overview` marker
  // existed: accept the Chinese overview labels they shipped and the language
  // independent route suffixes. Matching is on *data*, never rendered copy.
  return (
    item.label.includes('概览') || // i18n-exempt — legacy manifest data, not UI copy
    ['overview', 'summary'].includes(item.label.toLowerCase()) ||
    ['overview', 'summary'].includes(item.href.split('/').at(-1) ?? '')
  );
}

export function groupBackendNavigation(items: BackendNavigationItem[]) {
  const groups = new Map<string, BackendNavigationItem[]>();
  for (const item of items) {
    if (!item.group) continue;
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  return groups;
}

/** Hidden editor/detail routes inherit the explicitly declared owner, never a sibling overview. */
export function resolveBackendActiveItem(
  pathname: string,
  items: BackendNavigationItem[],
  rootHref: string,
): BackendNavigationItem | null {
  let active: BackendNavigationItem | null = null;
  let length = -1;
  for (const item of items) {
    for (const path of [item.href, ...(item.activePaths ?? [])]) {
      if (pathname === path || (path !== rootHref && pathname.startsWith(`${path}/`))) {
        if (path.length > length) {
          active = item;
          length = path.length;
        }
      }
    }
  }
  return active;
}
