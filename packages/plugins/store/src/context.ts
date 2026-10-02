import type {
  EventBus,
  ExtensionClient,
  ExtensionTransaction,
  PluginContext,
} from '@stackpanel/sdk';
import { StoreError } from './errors';

let ext: ExtensionClient | null = null;
let runTx: (<T>(fn: (tx: ExtensionTransaction) => Promise<T>) => Promise<T>) | null = null;
let log: PluginContext['logger'] | null = null;
let events: EventBus | null = null;
let ctx: PluginContext | null = null;

/** Bind plugin-scoped dependencies during activation. */
export function bindContext(pluginCtx: PluginContext): void {
  ext = pluginCtx.extensions;
  runTx = pluginCtx.tx;
  log = pluginCtx.logger;
  events = pluginCtx.events;
  ctx = pluginCtx;
}

/** Clear module state during deactivation. */
export function resetContext(): void {
  ext = null;
  runTx = null;
  log = null;
  events = null;
  ctx = null;
}

/** Resolve the active plugin context (throws 503 until activated). */
export function context(): PluginContext {
  if (!ctx) throw new StoreError(503, '商店插件未就绪');
  return ctx;
}

/** Resolve the plugin's extension client (throws 503 until activated). */
export function extensions(): ExtensionClient {
  if (!ext) throw new StoreError(503, '商店插件未就绪');
  return ext;
}

/** Run a set of extension/wallet/payment writes atomically via `ctx.tx`. */
export function runTransaction<T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T> {
  if (!runTx) throw new StoreError(503, '商店插件未就绪');
  return runTx(fn);
}

/** Resolve the plugin's logger (no-op when the plugin is not bound, so
 * background tasks finishing after deactivation do not throw). */
export function logger(): PluginContext['logger'] {
  return log ?? { info: () => {}, warn: () => {}, error: () => {} };
}

export function bus(): EventBus {
  if (!events) throw new StoreError(503, '商店插件未就绪');
  return events;
}
