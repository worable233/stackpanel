import type { AdminPageComponent } from '@stackpanel/sdk';
import * as admin0 from '../../../../data/plugins/catalog/frontend/dist/admin.js';
import * as admin1 from '../../../../data/plugins/cms/frontend/dist/admin.js';
import * as admin2 from '../../../../data/plugins/epay/frontend/dist/admin.js';
import * as admin3 from '../../../../data/plugins/invoice/frontend/dist/admin.js';
import * as admin4 from '../../../../data/plugins/llm-gateway/frontend/dist/admin.js';
import * as admin5 from '../../../../data/plugins/notice/frontend/dist/admin.js';
import * as admin6 from '../../../../data/plugins/referral/frontend/dist/admin.js';
import * as admin7 from '../../../../data/plugins/storage/frontend/dist/admin.js';
import * as admin8 from '../../../../data/plugins/store/frontend/dist/admin.js';
import * as admin9 from '../../../../data/plugins/store-wallet/frontend/dist/admin.js';
import * as admin10 from '../../../../data/plugins/ticket/frontend/dist/admin.js';
import * as admin11 from '../../../../data/plugins/zjmf-upstream/frontend/dist/admin.js';

/** Plugin admin page components resolved on the client for interactive pages. */
export const clientAdminRegistry = new Map<
  string,
  { adminPages: Record<string, AdminPageComponent> }
>([
  ['plugins/catalog', admin0],
  ['plugins/cms', admin1],
  ['plugins/epay', admin2],
  ['plugins/invoice', admin3],
  ['plugins/llm-gateway', admin4],
  ['plugins/notice', admin5],
  ['plugins/referral', admin6],
  ['plugins/storage', admin7],
  ['plugins/store', admin8],
  ['plugins/store-wallet', admin9],
  ['plugins/ticket', admin10],
  ['plugins/zjmf-upstream', admin11],
]);

export function getClientAdminPages(
  kind: 'themes' | 'plugins',
  id: string,
): Record<string, AdminPageComponent> | null {
  return clientAdminRegistry.get(`${kind}/${id}`)?.adminPages ?? null;
}
