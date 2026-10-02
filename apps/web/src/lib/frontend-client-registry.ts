import type { AdminPageComponent } from '@stackpanel/sdk';
import * as admin0 from '../../../../data/plugins/store/frontend/dist/admin.js';
import * as admin1 from '../../../../data/plugins/store-wallet/frontend/dist/admin.js';

/** Plugin admin page components resolved on the client for interactive pages. */
export const clientAdminRegistry = new Map<
  string,
  { adminPages: Record<string, AdminPageComponent> }
>([
  ['plugins/store', admin0],
  ['plugins/store-wallet', admin1],
]);

export function getClientAdminPages(
  kind: 'themes' | 'plugins',
  id: string,
): Record<string, AdminPageComponent> | null {
  return clientAdminRegistry.get(`${kind}/${id}`)?.adminPages ?? null;
}
