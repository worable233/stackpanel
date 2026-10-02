import type { PluginContext } from '@stackpanel/sdk';
import { WalletPluginError } from './errors';

let ctx: PluginContext | null = null;

/** Bind plugin-scoped dependencies during activation. */
export function bindContext(pluginCtx: PluginContext): void {
  ctx = pluginCtx;
}

/** Clear module state during deactivation. */
export function resetContext(): void {
  ctx = null;
}

/** Resolve the active plugin context (throws 503 until activated). */
export function context(): PluginContext {
  if (!ctx) throw new WalletPluginError(503, '钱包插件未就绪');
  return ctx;
}
