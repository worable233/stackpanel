/**
 * Resolve the commerce domain outlet (`EXTENSION_POINTS.commerce`) from the
 * plugin runtime. Kernel surfaces (SP v1, admin BFF, open API) call the domain
 * through this handle instead of reading the store plugin's tables directly
 * (ADR-0008 / ADR-0009).
 */
import type { CommerceOperations } from '@stackpanel/sdk';
import { EXTENSION_POINTS } from '@stackpanel/sdk';

export interface ExtensionResolver {
  getExtensions<T>(pointId: string): T[];
}

/** The store plugin's commerce outlet, or `null` when it is not active. */
export function resolveCommerce(runtime: ExtensionResolver): CommerceOperations | null {
  return runtime.getExtensions<CommerceOperations>(EXTENSION_POINTS.commerce)[0] ?? null;
}
