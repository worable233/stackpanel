import type { NotificationsService } from '@stackpanel/sdk';
import { notifyUserBestEffort } from './notify.ts';

/**
 * 存储（对象存储 / 本地磁盘）异常告警（对标 #12.5 的 `ossExceptionNotice`）。
 *
 * 对方每 5 分钟探一次 OSS，失败就通知管理员。直接照抄有两个问题：
 *
 * 1. **抖一下就通知**：一次超时可能是网络瞬时抖动，管理员会被无意义的告警训练成
 *    「不看了」。所以连续失败 `STORAGE_ALERT_AFTER_FAILURES` 次才发。
 * 2. **恢复后没有下文**：只报故障不报恢复，管理员不知道要不要继续排查。恢复同样
 *    需要连续 `STORAGE_RECOVERY_AFTER_SUCCESSES` 次成功才发，避免「故障/恢复」
 *    交替刷屏。
 *
 * 状态放在进程内存里：任务执行本身已被数据库租约 / BullMQ 收敛为「集群只跑一份」
 * （见 `REF-定时任务与幂等契约.md` §5.1），所以不需要跨副本共享。进程重启会丢失
 * 「已告警」标记 —— 若此时存储仍然不可用，会重新告警一次。这是**刻意**的：持久故障
 * 值得再提醒一次，而代价只是一条通知。
 *
 * 通知是告警的附属品：探测或写入失败都不向任务抛出，否则任务会进死信并被反复重试。
 */

/** 连续失败多少次才告警（5 分钟一次 → 约 15 分钟）。 */
export const STORAGE_ALERT_AFTER_FAILURES = 3;
/** 连续成功多少次才发「已恢复」（避免故障/恢复交替刷屏）。 */
export const STORAGE_RECOVERY_AFTER_SUCCESSES = 2;

export interface StorageWatchDeps {
  /** 探测存储可用性；实现内部应自己兜住异常，但抛错也按「不可用」处理。 */
  ping: () => Promise<boolean>;
  notifications: NotificationsService;
  /** 列出管理员用户 id（告警收件人）。 */
  listAdminIds: () => Promise<string[]>;
  logger: { warn: (message: string) => void; info?: (message: string) => void };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function createStorageWatch(deps: StorageWatchDeps): () => Promise<void> {
  let failures = 0;
  let successes = 0;
  let alerted = false;
  let lastError = '';

  const announce = async (notice: {
    type: 'admin.storage.unreachable' | 'admin.storage.recovered';
    title: string;
    body: string;
  }): Promise<void> => {
    const { type, title, body } = notice;
    let adminIds: string[];
    try {
      adminIds = await deps.listAdminIds();
    } catch (error) {
      deps.logger.warn(`[storage-watch] 读取管理员列表失败：${messageOf(error)}`);
      return;
    }
    if (adminIds.length === 0) {
      deps.logger.warn('[storage-watch] 没有可通知的管理员，告警被丢弃');
      return;
    }
    for (const userId of adminIds) {
      await notifyUserBestEffort(
        { notifications: deps.notifications, logger: deps.logger },
        { userId, type, title, body, link: '/admin/settings' },
      );
    }
    deps.logger.info?.(`[storage-watch] 已向 ${adminIds.length} 名管理员发送「${title}」`);
  };

  return async () => {
    let ok: boolean;
    try {
      ok = await deps.ping();
    } catch (error) {
      ok = false;
      lastError = messageOf(error);
    }
    if (!ok && !lastError) lastError = '探测返回不可用';

    if (ok) {
      failures = 0;
      lastError = '';
      if (!alerted) return;
      successes += 1;
      if (successes < STORAGE_RECOVERY_AFTER_SUCCESSES) return;
      successes = 0;
      alerted = false;
      await announce({
        // 字面量写在 `type:` 位置：`notification-type-coverage` 靠扫这个模式守门，
        // 用模板串拼类型就会绕过守门（正是这个测试存在的理由）。
        type: 'admin.storage.recovered',
        title: '存储已恢复',
        body: '此前不可用的对象存储已连续探测成功，媒体上传与附件下载应已恢复。',
      });
      return;
    }

    successes = 0;
    failures += 1;
    if (alerted || failures < STORAGE_ALERT_AFTER_FAILURES) return;
    alerted = true;
    await announce({
      type: 'admin.storage.unreachable',
      title: '存储不可用',
      body: `对象存储连续 ${failures} 次探测失败（最近一次：${lastError}），媒体上传与附件下载可能失败，请检查存储配置与网络。`,
    });
  };
}
