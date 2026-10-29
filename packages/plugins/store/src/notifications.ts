import type { NotificationStatus, NotificationTypeDefinition } from '@stackpanel/sdk';
import { context, logger } from './context';

/**
 * 交易通知出口（站内）。
 *
 * 内核拥有通知表与渠道分发；插件只负责「何时通知、通知谁、成功语义」。
 * 本模块把 store 的各类业务通知收拢到一处，统一：
 *   - `dedupeKey` 幂等键：支付/开通/续费这类 at-least-once 事件用 `upsert`
 *     原地改写同一条，重放不会给用户刷多条；一次性结果（下单/退款）用 `create`。
 *   - best-effort：通知失败只告警，绝不回滚业务（与内核 lifecycle 通知同构）。
 *
 * 通知本身仍会经内核 `notification.created` 事件进入渠道分发（邮件/webhook），
 * 由渠道按类型自行取舍。
 */

export interface StoreNotice {
  userId: string;
  type: string;
  title: string;
  body: string;
  link: string;
  data?: Record<string, unknown>;
  status?: NotificationStatus;
  /** 稳定幂等键：设置时用 upsert 原地改写，重放合并为一条。 */
  dedupeKey?: string;
}

/**
 * 声明本插件会发出的通知类型（`notification.type` 扩展点），供内核偏好目录展示。
 * 未声明的类型没有配置项、永远投递；本插件发出的类型都应是可配置的。
 * 纯进度类（开通中）默认仅站内，避免把每次进度更新都转成邮件。
 */
export const STORE_NOTIFICATION_TYPES: readonly NotificationTypeDefinition[] = [
  { type: 'order.pending', category: 'store', label: '订单待支付', order: 10 },
  { type: 'order.paid', category: 'store', label: '订单支付成功', order: 20 },
  { type: 'order.refunded', category: 'store', label: '订单已退款', order: 30 },
  { type: 'order.refund.requested', category: 'store', label: '退款申请待审核', audience: 'admin', order: 31 },
  { type: 'order.refund.rejected', category: 'store', label: '退款申请未通过', order: 32 },
  { type: 'order.refund.succeeded', category: 'store', label: '退款已进入平台余额', order: 33 },
  { type: 'order.refund.failed', category: 'store', label: '退款处理失败', order: 34 },
  {
    type: 'service.provisioning',
    category: 'store',
    label: '服务开通中',
    defaultChannels: ['inapp'],
    order: 40,
  },
  { type: 'service.provisioned', category: 'store', label: '服务已开通', order: 50 },
  { type: 'service.provision.failed', category: 'store', label: '服务开通失败', order: 60 },
  {
    type: 'admin.service.provision.failed',
    category: 'store',
    label: '服务开通失败（管理员）',
    audience: 'admin',
    order: 70,
  },
  { type: 'service.renewed', category: 'store', label: '服务续费成功', order: 80 },
  { type: 'service.expiring', category: 'store', label: '服务即将到期', order: 90 },
  { type: 'service.suspended', category: 'store', label: '服务已停用', order: 100 },
  { type: 'service.resumed', category: 'store', label: '服务已恢复', order: 105 },
  { type: 'service.terminated', category: 'store', label: '服务已终止', order: 110 },
  { type: 'service.changed', category: 'store', label: '服务配置已变更', order: 115 },
  // 变更失败必须让用户知道：钱已经付了、配置还没生效，只有服务器日志等于没发生。
  {
    type: 'service.change.failed',
    category: 'store',
    label: '配置变更失败（自动重试中）',
    order: 116,
  },
  {
    type: 'store.change.exhausted',
    category: 'store',
    label: '配置变更重试用尽（管理员）',
    audience: 'admin',
    order: 118,
  },
  { type: 'service.transferred', category: 'store', label: '服务已转移', order: 117 },
  { type: 'order.cancelled', category: 'store', label: '订单已取消', order: 35 },
];

/** 写入一条 store 业务通知。失败只告警，不抛出。 */
export async function notifyUser(notice: StoreNotice): Promise<void> {
  try {
    const service = context().notifications;
    const { dedupeKey } = notice;
    if (dedupeKey) {
      await service.upsert({
        userId: notice.userId,
        type: notice.type,
        title: notice.title,
        body: notice.body,
        link: notice.link,
        ...(notice.data ? { data: notice.data } : {}),
        ...(notice.status ? { status: notice.status } : {}),
        dedupeKey,
      });
    } else {
      await service.create({
        userId: notice.userId,
        type: notice.type,
        title: notice.title,
        body: notice.body,
        link: notice.link,
        ...(notice.data ? { data: notice.data } : {}),
        ...(notice.status ? { status: notice.status } : {}),
      });
    }
  } catch (error) {
    logger().warn(
      `store: notification ${notice.type} failed for ${notice.userId}: ${messageOf(error)}`,
    );
  }
}

/**
 * 广播给所有持有某权限的用户（管理员/运营）。收件人授权由内核解析
 * （`notifyPermissionHolders`），插件只声明「需哪个权限能处理」。失败只告警。
 */
export async function notifyAdmins(
  notice: Omit<StoreNotice, 'userId' | 'dedupeKey'>,
  permission = 'store.admin',
): Promise<void> {
  try {
    await context().notifications.notifyPermissionHolders(permission, {
      type: notice.type,
      title: notice.title,
      body: notice.body,
      link: notice.link,
      ...(notice.data ? { data: notice.data } : {}),
      ...(notice.status ? { status: notice.status } : {}),
    });
  } catch (error) {
    logger().warn(`store: admin notification ${notice.type} failed: ${messageOf(error)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}
