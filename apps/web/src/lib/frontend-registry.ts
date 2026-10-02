import 'server-only';

import type { FrontendPackage } from '@stackpanel/sdk';
import * as mod0 from '../../../../data/plugins/store/frontend/dist/index.js';
import * as mod1 from '../../../../data/plugins/store-wallet/frontend/dist/index.js';
import * as mod2 from '../../../../data/themes/aurora/frontend/dist/index.js';
import * as mod3 from '../../../../data/themes/default/frontend/dist/index.js';
import * as mod4 from '../../../../data/themes/stratus/frontend/dist/index.js';

function packageOf(mod: Record<string, unknown>): FrontendPackage {
  return ((mod as { default?: FrontendPackage }).default ?? mod) as FrontendPackage;
}

const frontendRegistry = new Map<string, FrontendPackage>([
  ['plugins/store', packageOf(mod0 as unknown as Record<string, unknown>)],
  ['plugins/store-wallet', packageOf(mod1 as unknown as Record<string, unknown>)],
  ['themes/aurora', packageOf(mod2 as unknown as Record<string, unknown>)],
  ['themes/default', packageOf(mod3 as unknown as Record<string, unknown>)],
  ['themes/stratus', packageOf(mod4 as unknown as Record<string, unknown>)],
]);

export function getFrontendPackage(kind: 'themes' | 'plugins', id: string): FrontendPackage | null {
  return frontendRegistry.get(`${kind}/${id}`) ?? null;
}

export function listFrontendPackageIds(kind?: 'themes' | 'plugins'): string[] {
  return Array.from(frontendRegistry.keys())
    .filter((key) => !kind || key.startsWith(`${kind}/`))
    .map((key) => key.split('/')[1] ?? '');
}
