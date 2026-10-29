import { AsyncLocalStorage } from 'node:async_hooks';
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

/**
 * 当前正在执行的扩展事务。
 *
 * `ctx.tx` 不允许嵌套：在已有事务里再开一层会直接抛 `extension.validation_error`
 * （「不允许嵌套 ctx.tx」）。而「订单支付」这类入口本身就是事务内的，履约钩子又在
 * 其中调用了需要事务的写入，于是**每一次**都会先失败一次、再靠定时重试成功。
 * 用 AsyncLocalStorage 记住进行中的事务，重入时直接复用外层，语义就是「一起提交」。
 */
const activeTx = new AsyncLocalStorage<ExtensionTransaction>();

/** Run a set of extension/wallet/payment writes atomically via `ctx.tx`. */
export function runTransaction<T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T> {
  const outer = activeTx.getStore();
  if (outer) return fn(outer);
  if (!runTx) throw new StoreError(503, '商店插件未就绪');
  return runTx((tx) => activeTx.run(tx, () => fn(tx)));
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
