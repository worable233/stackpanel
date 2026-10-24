import type {
  CreateNotificationInput,
  NotificationStatus,
  NotificationsService,
  UpsertNotificationInput,
} from '@stackpanel/sdk';

/**
 * 内核侧通知的**统一出口**。
 *
 * 通知是业务结果的附属品，不是业务本身：任何通知写入失败都只告警，绝不让
 * 主流程（充值、改密、转账……）回滚或返回错误。生命周期通知
 * （`lifecycle-notifications.ts`）与 Agent 通知（`agent-notifications.ts`）各有
 * 自己的队列/去重语义，这里只收敛「一次性、best-effort」的场景。
 *
 * 两个变体：
 *   - {@link notifyUserBestEffort}：一次性通知，无需幂等键。
 *   - {@link upsertUserBestEffort}：带 `dedupeKey` 的实况通知，重放合并为一条。
 */

export interface NotifyTarget {
  notifications: NotificationsService;
  logger?: { warn: (message: string) => void };
}

function warnOf(target: NotifyTarget, message: string): void {
  target.logger?.warn(`[notify] ${message}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** 写入一条一次性站内通知；失败只告警。返回是否写入成功。 */
export async function notifyUserBestEffort(
  target: NotifyTarget,
  input: CreateNotificationInput & { status?: NotificationStatus },
): Promise<boolean> {
  try {
    await target.notifications.create(input);
    return true;
  } catch (error) {
    warnOf(target, `${input.type} -> ${input.userId} 写入失败：${messageOf(error)}`);
    return false;
  }
}

/**
 * 写入/原地更新一条实况通知（`dedupeKey` 必填）；失败只告警。
 * 返回是否写入成功。
 */
export async function upsertUserBestEffort(
  target: NotifyTarget,
  input: UpsertNotificationInput,
): Promise<boolean> {
  try {
    await target.notifications.upsert(input);
    return true;
  } catch (error) {
    warnOf(target, `${input.type} -> ${input.userId} 更新失败：${messageOf(error)}`);
    return false;
  }
}
