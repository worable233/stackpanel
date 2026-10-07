import type { NotificationStatus, NotificationsService } from '@stackpanel/sdk';

/**
 * 插件 / 主题生命周期通知。管理员执行安装、升级、启用/激活、停用、卸载/删除后，
 * 给**操作者本人**写一条一次性站内通知（进铃铛与收件箱）。
 *
 * 与 `frontend-apply-notifications.ts` 的区别：
 *   - 实况通知（live）：针对**前端构建**这类持续活动，用 `upsert` 原地改写同一条。
 *   - 生命周期通知（本模块）：针对**管理动作的结果**，用 `create` 追加一次性消息。
 *
 * 去重规则：当同一次操作同时触发前端构建（目标存在前端产物）时，安装/升级/卸载
 * 不再发生命周期通知，由 `frontend-apply` 实况通知覆盖结果；启用/停用/激活不触发构建，
 * 始终发通知。详见路由接线。
 */

export type LifecycleTarget = 'plugin' | 'theme';

export type LifecycleAction =
  | 'install'
  | 'update'
  | 'remove'
  | 'enable'
  | 'disable'
  | 'activate'
  | 'uninstall';

export interface LifecycleNotificationEvent {
  target: LifecycleTarget;
  action: LifecycleAction;
  /** 人类可读名称（插件名 / 主题名）。 */
  label: string;
  /** 插件 / 主题 id。 */
  id: string;
  /** 版本号（若已知）。 */
  version?: string;
  /** 操作是否成功；失败时 `error` 必填。 */
  ok: boolean;
  /** 失败原因（`ok === false` 时展示给用户）。 */
  error?: string;
}

export interface LifecycleNotificationContent {
  type: string;
  title: string;
  body: string;
  status: NotificationStatus;
  link: string;
  data: Record<string, unknown>;
}

const NOUN: Record<LifecycleTarget, string> = { plugin: '插件', theme: '主题' };

/** 动作文案：成功 / 失败各一套，贴合中文后台语气。 */
const ACTION_LABEL: Record<LifecycleAction, { done: string; failed: string; active: string }> = {
  install: { done: '安装完成', failed: '安装失败', active: '已安装' },
  update: { done: '升级完成', failed: '升级失败', active: '已升级' },
  remove: { done: '卸载完成', failed: '卸载失败', active: '已卸载' },
  uninstall: { done: '卸载完成', failed: '卸载失败', active: '已卸载' },
  enable: { done: '已启用', failed: '启用失败', active: '已启用' },
  disable: { done: '已停用', failed: '停用失败', active: '已停用' },
  activate: { done: '已激活', failed: '激活失败', active: '已激活' },
};

const ADMIN_PATH: Record<LifecycleTarget, string> = {
  plugin: '/admin/plugins',
  theme: '/admin/themes',
};

/** 由事件派生通知内容。纯函数，便于脱离 DB 单测。 */
export function lifecycleNotification(
  event: LifecycleNotificationEvent,
): LifecycleNotificationContent {
  const noun = NOUN[event.target];
  const label = `「${event.label}」`;
  const verb = ACTION_LABEL[event.action];
  const title = `${noun}${label}${event.ok ? verb.done : verb.failed}`;
  const versionHint = event.version ? ` v${event.version}` : '';
  const body = event.ok
    ? `${label}${verb.active}${versionHint}`
    : (event.error ?? `操作未完成，请重试`);
  return {
    type: `system.${event.target}.${event.action}`,
    title,
    body,
    status: event.ok ? 'success' : 'error',
    link: ADMIN_PATH[event.target],
    data: {
      kind: 'lifecycle',
      target: event.target,
      action: event.action,
      id: event.id,
      ok: event.ok,
    },
  };
}

export interface LifecycleNotifierOptions {
  notifications: NotificationsService;
  logger?: { warn: (message: string) => void };
}

/** 构造一个 best-effort 生命周期通知器（写入失败只告警，不抛出）。 */
export function createLifecycleNotifier(options: LifecycleNotifierOptions) {
  return async (userId: string | null | undefined, event: LifecycleNotificationEvent): Promise<void> => {
    if (!userId) return;
    const content = lifecycleNotification(event);
    try {
      await options.notifications.create({
        userId,
        type: content.type,
        title: content.title,
        body: content.body,
        link: content.link,
        data: content.data,
        status: content.status,
      });
    } catch (error) {
      options.logger?.warn(
        `[lifecycle] 写入通知失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

/**
 * 路由直接调用的一次性入口：惰性构造内核通知服务后写入。best-effort，
 * 任何失败都被吞掉——通知绝不能阻断管理操作。
 *
 * 模块导入惰性化，保持路由对 DB / 事件总线的加载耦合不提前到模块加载期
 * （与 `notifyFrontendApplyQueued` 同构）。
 */
export async function notifyLifecycle(
  userId: string | null | undefined,
  event: LifecycleNotificationEvent,
): Promise<void> {
  if (!userId) return;
  try {
    const [{ getPrisma }, { getEventBus }, { KernelNotificationsService }] = await Promise.all([
      import('../plugins/prisma.ts'),
      import('../plugins/events.ts'),
      import('./notifications-service.ts'),
    ]);
    const notifier = createLifecycleNotifier({
      notifications: new KernelNotificationsService({ db: getPrisma(), events: getEventBus() }),
      logger: { warn: (message) => console.warn(message) },
    });
    await notifier(userId, event);
  } catch (error) {
    console.warn(
      `[lifecycle] 写入通知失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
