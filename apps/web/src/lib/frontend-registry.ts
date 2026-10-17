import 'server-only';

import type { FrontendPackage } from '@stackpanel/sdk';

/**
 * Stage 5: runtime frontend loading is the default, so no package is statically
 * bundled here. Regenerate a populated registry with
 * `STACKPANEL_FRONTEND_RUNTIME_LOAD=0 pnpm build:frontend` (fallback path).
 */
export function getFrontendPackage(_kind: 'themes' | 'plugins', _id: string): FrontendPackage | null {
  void _kind;
  void _id;
  return null;
}

export function listFrontendPackageIds(kind?: 'themes' | 'plugins'): string[] {
  void kind;
  return [];
}
