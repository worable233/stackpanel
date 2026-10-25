import { context, logger } from './context';
import {
  claimUnpaidReminder,
  getOrder,
  listOrdersToRemind,
  releaseUnpaidReminder,
  UNPAID_REMIND_AFTER_MS,
  type OrderRecord,
} from './repository';

/**
 * 未付款订单催付（对标 #12.5）。
 *
 * ZJMF 是「每日扫一遍，创建后第 N 天发一条」。这里换成**按到期时间戳**驱动：
 * 下单时就把 `unpaidRemindAtMs = now + 24h` 写进订单，任务每小时扫一次
 * `<= now` 的行。两种写法对用户看到的差别不大，但后者有两点好处：
 *
 * 1. **能补发**：任务停两天，恢复后照样把该发的发出去。对方的「每日等值窗口」
 *    一旦那天没跑，这条提醒就永久丢了。
 * 2. **可重复执行**：认领是一次条件更新（`unpaidRemindedAt IS NULL → 时间戳`），
 *    同一笔订单重复扫到也只会发一次；通知失败则把标记退回 NULL 等下一轮。
 *
 * 只提醒「仍未支付」的订单：状态在扫描与认领之间被支付的话，认领条件里的
 * `state` 不参与（认领只看标记），但通知前会再确认一次状态 —— 用户刚付完款
 * 就收到「请尽快支付」是最容易招致投诉的那种 bug。
 */

/** 每小时扫一次：比「每日一次」更容易补发，代价只是一次索引查询。 */
export const UNPAID_REMIND_INTERVAL_MS = 60 * 60 * 1000;
/** 单轮处理上限，避免积压时一次拉太多。 */
export const UNPAID_REMIND_BATCH = 50;

interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  link: string;
  data?: Record<string, unknown>;
}

function formatAmount(order: OrderRecord): string {
  return `${(order.total / 100).toFixed(2)} ${order.currency}`;
}

async function notify(input: NotifyInput): Promise<boolean> {
  try {
    await context().notifications.create(input);
    return true;
  } catch (error) {
    logger().warn(`store: 未付款催付通知发送失败（${input.data?.orderId ?? '?'}）：${String(error)}`);
    return false;
  }
}

/** 催付入口：由内核周期任务调用。`now` 可注入，便于测试。 */
export async function runUnpaidOrderReminder(now: Date = new Date()): Promise<void> {
  const due = await listOrdersToRemind(now.getTime(), UNPAID_REMIND_BATCH);
  for (const order of due) {
    // 认领：只有「尚未催付」的行会被改。抢不到说明别的副本/上一轮已经处理。
    const claimed = await claimUnpaidReminder(order.id, now);
    if (!claimed) continue;

    // 认领与发送之间可能刚完成支付：用户刚付完就收到「请尽快支付」是最招投诉的 bug。
    const fresh = await getOrder(order.id);
    if (!fresh || fresh.status !== 'PENDING') continue;

    const delivered = await notify({
      userId: order.userId,
      type: 'order.unpaid',
      title: '订单待支付',
      body: `订单 ${order.id}（${formatAmount(order)}）尚未支付，请尽快完成支付。`,
      link: `/account/orders/${order.id}`,
      data: { orderId: order.id, total: order.total, currency: order.currency },
    });
    if (!delivered) {
      // 退回未催付，下一轮重试；否则这笔订单永远不会再被提醒。
      await releaseUnpaidReminder(order.id);
      continue;
    }
    logger().info(`store: 已催付未付款订单 ${order.id}`);
  }
}

export { UNPAID_REMIND_AFTER_MS };
