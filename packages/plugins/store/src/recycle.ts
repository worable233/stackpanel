import { logger } from './context';
import { recordStoreAudit, STORE_AUDIT_ACTIONS } from './audit';
import { deleteOrderInstance, listRecycledOrdersBefore } from './repository';

/**
 * 未支付订单的回收站与清理（对标整改 #12.1）。
 *
 * 语义：用户「删除」未支付（已取消）订单时只打 `deletedAt` 时间戳——
 * 订单仍在库里，管理员能看见、能恢复、能对账；超过保留期后由 **周期任务**
 * 真正删除。支付中的订单不允许进回收站：那会让一笔仍可能成功的支付从
 * 用户视野里消失。
 *
 * 与 `expiry.ts` 一致，扫描走 `ctx.jobs`（集群下只由一个 worker 执行），
 * 单轮有限批量，失败只记日志不抛给调度器。
 */

/** 回收站保留期（毫秒）：超过后真删。默认 30 天。 */
export const RECYCLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** 清理扫描周期（毫秒）：每 6 小时一次。 */
export const ORDER_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 单轮清理条数上限（与到期扫描同样的上限思路）。 */
export const ORDER_PURGE_BATCH = 50;

export interface OrderPurgeResult {
  /** 本轮到期（回收时间早于 cutoff）的订单数。 */
  scanned: number;
  /** 真正删除成功的条数。 */
  purged: number;
}

/**
 * 物理删除回收站中已过保留期的订单。
 *
 * 幂等：已删除的行下一轮不再被扫到；单条失败只告警，不影响其余条目。
 */
export async function purgeRecycledOrders(now: Date = new Date()): Promise<OrderPurgeResult> {
  const cutoff = new Date(now.getTime() - RECYCLE_RETENTION_MS).toISOString();
  const due = await listRecycledOrdersBefore(cutoff, ORDER_PURGE_BATCH);
  let purged = 0;
  for (const order of due) {
    try {
      await deleteOrderInstance(order.id);
      purged += 1;
      // 审计保留「删了什么」，但对账需要的金额/币种一并记下：真删之后
      // 只剩这条审计能回答「这单曾经存在过」。
      await recordStoreAudit({
        action: STORE_AUDIT_ACTIONS.orderPurged,
        resource: 'store/order',
        resourceId: order.id,
        meta: {
          status: order.status,
          total: order.total,
          currency: order.currency,
          deletedAt: order.deletedAt,
        },
      });
    } catch (error) {
      logger().warn(
        `store: purge order ${order.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { scanned: due.length, purged };
}
