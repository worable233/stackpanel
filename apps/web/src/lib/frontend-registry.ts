import 'server-only';

import type { FrontendPackage } from '@stackpanel/sdk';
import * as mod0 from '../../../../data/plugins/catalog/frontend/dist/index.js';
import * as mod1 from '../../../../data/plugins/cms/frontend/dist/index.js';
import * as mod2 from '../../../../data/plugins/epay/frontend/dist/index.js';
import * as mod3 from '../../../../data/plugins/invoice/frontend/dist/index.js';
import * as mod4 from '../../../../data/plugins/llm-gateway/frontend/dist/index.js';
import * as mod5 from '../../../../data/plugins/notice/frontend/dist/index.js';
import * as mod6 from '../../../../data/plugins/store/frontend/dist/index.js';
import * as mod7 from '../../../../data/plugins/store-wallet/frontend/dist/index.js';
import * as mod8 from '../../../../data/plugins/ticket/frontend/dist/index.js';
import * as mod9 from '../../../../data/plugins/zjmf-upstream/frontend/dist/index.js';
import * as mod10 from '../../../../data/themes/aurora/frontend/dist/index.js';
import * as mod11 from '../../../../data/themes/default/frontend/dist/index.js';
import * as mod12 from '../../../../data/themes/stratus/frontend/dist/index.js';

function packageOf(mod: Record<string, unknown>): FrontendPackage {
  return ((mod as { default?: FrontendPackage }).default ?? mod) as FrontendPackage;
}

const frontendRegistry = new Map<string, FrontendPackage>([
  ['plugins/catalog', packageOf(mod0 as unknown as Record<string, unknown>)],
  ['plugins/cms', packageOf(mod1 as unknown as Record<string, unknown>)],
  ['plugins/epay', packageOf(mod2 as unknown as Record<string, unknown>)],
  ['plugins/invoice', packageOf(mod3 as unknown as Record<string, unknown>)],
  ['plugins/llm-gateway', packageOf(mod4 as unknown as Record<string, unknown>)],
  ['plugins/notice', packageOf(mod5 as unknown as Record<string, unknown>)],
  ['plugins/store', packageOf(mod6 as unknown as Record<string, unknown>)],
  ['plugins/store-wallet', packageOf(mod7 as unknown as Record<string, unknown>)],
  ['plugins/ticket', packageOf(mod8 as unknown as Record<string, unknown>)],
  ['plugins/zjmf-upstream', packageOf(mod9 as unknown as Record<string, unknown>)],
  ['themes/aurora', packageOf(mod10 as unknown as Record<string, unknown>)],
  ['themes/default', packageOf(mod11 as unknown as Record<string, unknown>)],
  ['themes/stratus', packageOf(mod12 as unknown as Record<string, unknown>)],
]);

export function getFrontendPackage(kind: 'themes' | 'plugins', id: string): FrontendPackage | null {
  return frontendRegistry.get(`${kind}/${id}`) ?? null;
}

export function listFrontendPackageIds(kind?: 'themes' | 'plugins'): string[] {
  return Array.from(frontendRegistry.keys())
    .filter((key) => !kind || key.startsWith(`${kind}/`))
    .map((key) => key.split('/')[1] ?? '');
}
