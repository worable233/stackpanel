import type { ExtensionClient, ExtensionTransaction, PluginContext } from '@stackpanel/sdk';
import { PluginError } from '@stackpanel/sdk';

/** Stable error codes (ADR-0012). */
const MEMBERSHIP_ERROR_CODES: Record<string, string> = {
  参数无效: 'validation.invalid',
  会员插件未就绪: 'store.membership.not_ready',
  权限组不存在: 'store.membership.group_not_found',
  商品未配置会员权益: 'store.membership.not_configured',
  '未找到可续期的会员权益，请联系客服': 'store.membership.not_renewable',
  无法确定该服务的会员权益组: 'store.membership.group_unknown',
  会员权益不存在: 'store.membership.not_found',
};

/** 插件内错误：携带稳定 code 与 HTTP 状态，交给内核渲染 problem+json。 */
export class MembershipError extends PluginError {
  constructor(status: number, message: string) {
    super(MEMBERSHIP_ERROR_CODES[message] ?? 'store.membership.error', status, message);
    this.name = 'MembershipError';
  }
}

type TransactionRunner = <T>(fn: (tx: ExtensionTransaction) => Promise<T>) => Promise<T>;

let pluginCtx: PluginContext | null = null;
let extensionClient: ExtensionClient | null = null;
let transactionRunner: TransactionRunner | null = null;

/** Bind plugin-scoped dependencies during activation. */
export function bindContext(ctx: PluginContext): void {
  pluginCtx = ctx;
  extensionClient = ctx.extensions;
  transactionRunner = ctx.tx;
}

/** Clear module state during deactivation. */
export function clearContext(): void {
  pluginCtx = null;
  extensionClient = null;
  transactionRunner = null;
}

/** 当前插件上下文（未激活时抛 503）。 */
export function context(): PluginContext {
  if (!pluginCtx) throw new MembershipError(503, '会员插件未就绪');
  return pluginCtx;
}

/** 插件的扩展模型客户端（未激活时抛 503）。 */
export function extensions(): ExtensionClient {
  if (!extensionClient) throw new MembershipError(503, '会员插件未就绪');
  return extensionClient;
}

/** 在 `ctx.tx` 事务里执行一组写操作。 */
export function runTransaction<T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T> {
  if (!transactionRunner) throw new MembershipError(503, '会员插件未就绪');
  return transactionRunner(fn);
}

/** 日志器（未激活时静默，避免后台任务在停用后抛错）。 */
export function logger(): PluginContext['logger'] {
  return pluginCtx?.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
}

/** 错误信息归一化。 */
export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}
