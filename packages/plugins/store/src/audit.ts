/**
 * 商城审计事件（PLAN-storefront-display-account-commerce §3 阶段 3）。
 *
 * 记录商城入口、商品、订单与支付结果，但**不记录**支付凭据、上游密钥或
 * 任何敏感配置值。走内核 `ctx.auth.audit` 的 append-only 审计日志；
 * 审计失败只告警、绝不阻断业务。
 */
import type { HttpRequest } from '@stackpanel/sdk';
import { context, logger } from './context';

/** 审计条目允许的元数据：仅原始标量，杜绝把整个请求体写进日志。 */
type AuditMeta = Record<string, string | number | boolean | null>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface StoreAuditInput {
  action: string;
  resource: string;
  resourceId?: string | null;
  actorId?: string | null;
  meta?: AuditMeta;
  ip?: string;
}

/** 落一条商城审计；失败仅告警。 */
export async function recordStoreAudit(input: StoreAuditInput): Promise<void> {
  try {
    const auth = context().auth;
    if (!auth || typeof auth.audit !== 'function') return;
    await auth.audit({
      action: input.action,
      resource: input.resource,
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
      ...(input.ip ? { ip: input.ip } : {}),
    });
  } catch (error) {
    logger().warn(`store: audit ${input.action} failed: ${messageOf(error)}`);
  }
}

/** 从请求提取审计用标量上下文（用户 id / IP）。 */
export function auditActor(req: HttpRequest): { actorId?: string; ip?: string } {
  return {
    ...(req.user?.id ? { actorId: req.user.id } : {}),
    ...(req.ip ? { ip: req.ip } : {}),
  };
}

/** 订单结果的稳定审计动作名。 */
export const STORE_AUDIT_ACTIONS = {
  orderPlaced: 'store.order.placed',
  orderPaid: 'store.order.paid',
  orderPending: 'store.order.pending',
  orderCancelled: 'store.order.cancelled',
  cartCheckout: 'store.cart.checkout',
  serviceRenewed: 'store.service.renewed',
  serviceChanged: 'store.service.changed',
} as const;
