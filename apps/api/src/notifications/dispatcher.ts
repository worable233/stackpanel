import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@stackpanel/db';
import type {
  EventBus,
  EventMeta,
  NotificationChannel,
  NotificationDispatch,
  NotificationPolicyService,
  NotificationView,
} from '@stackpanel/sdk';

/**
 * 外部通知渠道分发底座（审计 §5）。
 *
 * 职责边界：
 *   - **内核拥有**：收件人授权（通知已按 userId 落库）、渠道分发、持久投递记录、
 *     幂等键、退避重试与失败重放。
 *   - **渠道插件只做投递**：注册 `notification.channel`，实现 `NotificationChannel.deliver`；
 *     抛错即请求重试。
 *
 * 可靠性：
 *   - 站内通知创建/更新后，本分发器为「每个想要该通知的渠道」写一条持久投递记录
 *     （PENDING），再尝试投递。写记录先于投递，进程崩溃也不会丢投递意图。
 *   - 投递按 (notificationId, channelId) 幂等；重复事件/重放合并为一行，绝不重复发送。
 *   - 到期投递由内核周期任务 `notifications.sweep-deliveries` 驱动（集群下单次执行），
 *     条件认领 + 指数退避；超过 maxAttempts 记为 FAILED 死信，等待人工/管理重放。
 *
 * 与站内通知分离的意义：站内消息落库不能证明外部邮件已被服务商接受或最终送达，
 * 因此投递状态必须独立记录与重试。
 */

export interface NotificationDispatcherOptions {
  db: PrismaClient;
  events: EventBus;
  /** Resolve the currently registered channels (live extension point read). */
  getChannels: () => NotificationChannel[];
  /**
   * Two-level preference engine. Applied per `(user, type, channel)` before a
   * channel is even asked: a disabled/locked type never produces a delivery
   * record. Undeclared types resolve to "enabled" (no config entry = cannot be
   * disabled). Optional so unit tests can construct a dispatcher without it;
   * when omitted, every channel is treated as enabled.
   */
  policy?: NotificationPolicyService;
  logger?: { info?: (message: string) => void; warn: (message: string) => void };
  /** Delivery attempt ceiling before a record becomes a dead letter. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
/** 退避上限（毫秒）：1s、2s、4s… 最多约 1 小时。 */
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export class NotificationDispatcher {
  private started = false;
  private readonly maxAttempts: number;

  constructor(private readonly options: NotificationDispatcherOptions) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * 订阅站内通知创建/更新事件，把通知 fan-out 到外部渠道。幂等：重复订阅无副作用。
   *
   * 投递是 at-least-once（relay 崩溃重投、副本离线后 catch-up 补齐），所以副作用
   * 必须按 `(consumer, eventId)` 去重：同一事件的重复投递只 fan-out 一次。
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const topic of ['notification.created', 'notification.updated'] as const) {
      this.options.events.subscribe(topic, (payload, meta) => {
        void this.dispatchOnce(payload.notification, payload.userId, meta).catch((error) => {
          this.warn(`dispatch(${topic}) failed: ${messageOf(error)}`);
        });
      });
    }
  }

  /**
   * Idempotent entry point: the same outbox event never fans out twice, even if
   * both the live relay and this replica's catch-up deliver it.
   */
  private async dispatchOnce(
    notification: NotificationView,
    userId: string,
    meta?: EventMeta,
  ): Promise<void> {
    const run = () => this.dispatch(notification, userId).then(() => undefined);
    if (!meta?.eventId || typeof this.options.events.runIdempotent !== 'function') {
      await run();
      return;
    }
    await this.options.events.runIdempotent('notifications.dispatcher', meta.eventId, run);
  }

  /**
   * 为一条通知记录并向每个「想要它」的渠道投递。先写持久意图再投递。
   * 返回创建的投递记录条数。
   */
  async dispatch(notification: NotificationView, userId: string): Promise<number> {
    const channels = this.options.getChannels();
    if (channels.length === 0) return 0;
    const projection: NotificationDispatch = {
      notificationId: notification.id,
      userId,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      link: notification.link,
      data: notification.data,
      status: notification.status,
      progress: notification.progress,
      createdAt: notification.createdAt,
    };
    let created = 0;
    for (const channel of channels) {
      // 两级偏好：管理员策略 × 用户覆盖，先于渠道自身的 wants() 判定。
      // 未声明类型恒为启用；关闭时跳过（已存在的 PENDING 记录由 deliverOne 兜底标记）。
      if (this.options.policy) {
        let enabled = true;
        try {
          enabled = await this.options.policy.isEnabled(userId, projection.type, channel.id);
        } catch (error) {
          this.warn(`policy check failed for ${projection.type}: ${messageOf(error)}`);
        }
        if (!enabled) continue;
      }
      let wanted: boolean;
      try {
        wanted = channel.wants ? await channel.wants(projection) : true;
      } catch (error) {
        this.warn(`channel ${channel.id} wants() threw: ${messageOf(error)}`);
        // 无法判断偏好时保守跳过，绝不因偏好查询失败而误发。
        continue;
      }
      if (!wanted) continue;
      const payload = projection as unknown as Prisma.InputJsonValue;
      // Replay safety: a re-delivered event (at-least-once) must not reset a
      // terminal DELIVERED row back to PENDING — that would re-send an email
      // that already went out. Only re-arm when the content actually changed.
      const existing = await this.options.db.notificationDelivery.findUnique({
        where: {
          notificationId_channelId: {
            notificationId: notification.id,
            channelId: channel.id,
          },
        },
        select: { payload: true, status: true },
      });
      const contentChanged = !existing || stableJson(existing.payload) !== stableJson(payload);
      if (existing?.status === 'DELIVERED' && !contentChanged) {
        // Already delivered and unchanged: nothing to do.
        continue;
      }
      if (existing && !contentChanged) {
        // Unchanged replay of an in-flight/failed row: leave it to `sweep`, which
        // owns backoff. Re-attempting here would bypass the retry window.
        created += 1;
        continue;
      }
      const record = await this.options.db.notificationDelivery.upsert({
        where: {
          notificationId_channelId: {
            notificationId: notification.id,
            channelId: channel.id,
          },
        },
        create: {
          notificationId: notification.id,
          channelId: channel.id,
          userId,
          payload,
          status: 'PENDING',
          maxAttempts: this.maxAttempts,
        },
        // A changed body re-arms delivery (preserving the attempt count).
        update: { payload, status: 'PENDING', nextAttemptAt: new Date(), lastError: null },
      });
      created += 1;
      await this.deliverOne(record.id, channel, projection);
    }
    return created;
  }

  /**
   * 重试所有到期未投递的记录（由内核周期任务调用）。用数据库条件认领串行化多副本，
   * 单个渠道失败只影响该记录。
   */
  async sweep(batch = 50): Promise<void> {
    const due = await this.options.db.notificationDelivery.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: batch,
      select: { id: true, channelId: true },
    });
    for (const row of due) {
      const channel = this.channelById(row.channelId);
      if (!channel) {
        // 渠道插件已卸载：标记死信而非无限重试。
        await this.options.db.notificationDelivery.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { status: 'FAILED', lastError: `渠道 ${row.channelId} 不可用` },
        });
        continue;
      }
      const record = await this.options.db.notificationDelivery.findUnique({
        where: { id: row.id },
      });
      if (!record) continue;
      await this.deliverOne(record.id, channel, record.payload as unknown as NotificationDispatch);
    }
  }

  /** 未投递（PENDING）记录数，供健康/指标。 */
  async pendingCount(): Promise<number> {
    return this.options.db.notificationDelivery.count({ where: { status: 'PENDING' } });
  }

  private channelById(id: string): NotificationChannel | undefined {
    return this.options.getChannels().find((channel) => channel.id === id);
  }

  private async deliverOne(
    id: string,
    channel: NotificationChannel,
    projection: NotificationDispatch,
  ): Promise<void> {
    // 条件认领：只有仍为 PENDING 且到期的记录才被尝试，且自增 attempts。
    // 多副本并发时只有一个能认领成功（避免重复投递）。
    const claim = await this.options.db.notificationDelivery.updateMany({
      where: { id, status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 60_000) },
    });
    if (claim.count === 0) return;
    // 认领后再查一次偏好：用户可能在记录写入之后才关闭该渠道（例如请求先落库、
    // sweep 稍后重试）。此时应停止投递并终止该记录，而不是继续重发。
    if (this.options.policy) {
      let enabled = true;
      try {
        enabled = await this.options.policy.isEnabled(
          projection.userId,
          projection.type,
          channel.id,
        );
      } catch (error) {
        this.warn(`policy check failed for ${projection.type}: ${messageOf(error)}`);
      }
      if (!enabled) {
        await this.options.db.notificationDelivery.update({
          where: { id },
          data: { status: 'FAILED', lastError: '接收人已关闭该通知渠道' },
        });
        return;
      }
    }
    const record = await this.options.db.notificationDelivery.findUnique({ where: { id } });
    try {
      await channel.deliver(projection);
      await this.options.db.notificationDelivery.update({
        where: { id },
        data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: null },
      });
    } catch (error) {
      const attempts = record?.attempts ?? 1;
      const dead = attempts >= this.maxAttempts;
      // 指数退避：1s、2s、4s…（封顶 1 小时）；命中上限则置死信。
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 12));
      await this.options.db.notificationDelivery.update({
        where: { id },
        data: {
          status: dead ? 'FAILED' : 'PENDING',
          nextAttemptAt: new Date(Date.now() + backoff),
          lastError: messageOf(error),
        },
      });
      this.warn(
        `channel ${channel.id} delivery ${dead ? 'exhausted' : 'failed'} for ${projection.notificationId}: ${messageOf(error)}`,
      );
    }
  }

  private warn(message: string): void {
    this.options.logger?.warn(`[notifications.dispatch] ${message}`);
  }
}

/** 幂等键：通知 + 渠道（用于外部/测试断言，服务内部由唯一索引保证）。 */
export function deliveryKey(notificationId: string, channelId: string): string {
  return createHash('sha256').update(`${notificationId}:${channelId}`).digest('hex');
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}

/** Deterministic JSON for content-change detection (key order must not matter). */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}
