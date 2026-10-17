import type { AdminPageComponent } from '@stackpanel/sdk';

/** Stage 5: runtime admin loading is the default; no client pages are statically bundled here. */
export const clientAdminRegistry = new Map<
  string,
  { adminPages: Record<string, AdminPageComponent> }
>();

export function getClientAdminPages(
  _kind: 'themes' | 'plugins',
  _id: string,
): Record<string, AdminPageComponent> | null {
  void _kind;
  void _id;
  return null;
}
