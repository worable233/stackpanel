import type { NotificationStatus, NotificationsService } from '@stackpanel/sdk';
import type { FrontendApplyRequest, FrontendApplyStatus } from '../lib/frontend-apply.ts';
/** Payload shape written by the builder, without the derived `at` timestamp. */
export type FrontendApplyStatusInput = Omit<FrontendApplyStatus, 'at'>;

/** Callback threaded through the builder to publish live apply notifications. */
export type FrontendApplyNotifier = (
  request: FrontendApplyRequest,
  status: FrontendApplyStatusInput,
) => Promise<void>;

/** Stable dedupe key: one live "front-end apply" activity per admin. */
export const FRONTEND_APPLY_NOTIFICATION_KEY = 'frontend-apply';

const ACTIONS: Record<FrontendApplyRequest['action'], string> = {
  install: '安装',
  update: '升级',
  remove: '卸载',
};

const STEPS = {
  pending: '已排队，等待 Web 处理',
  processing: '正在处理',
  succeeded: '已完成',
} as const;

export interface FrontendApplyNotification {
  title: string;
  body: string;
  status: NotificationStatus;
  progress: number;
  data: Record<string, unknown>;
}

/** Overall completion for the bar; settled states are 100. */
function progressValue(status: FrontendApplyStatusInput): number {
  if (status.state === 'succeeded' || status.state === 'failed') return 100;
  const total = status.steps?.length ?? 4;
  const step = Math.min(Math.max(status.step ?? 1, 1), total);
  return Math.max(Math.round(((step - 1) / total) * 100), 8);
}

/**
 * Derive the notification content from a build status. Kept pure so the wording
 * and the machine-readable `data` payload can be unit-tested without a DB.
 *
 * The text is Chinese (backend/system content, per the project convention); the
 * structured `data` carries the fields a localized client could render from.
 */
export function frontendApplyNotification(
  request: FrontendApplyRequest,
  status: FrontendApplyStatusInput,
): FrontendApplyNotification {
  const noun = request.target === 'theme' ? '主题' : '插件';
  const action = ACTIONS[request.action];
  const label = request.label ? `「${request.label}」` : '';
  const subject = `${noun}${label}`;
  const total = status.steps?.length ?? 0;
  const step = status.step ?? 1;
  const data: Record<string, unknown> = {
    kind: 'frontend-apply',
    reason: request.reason,
    target: request.target,
    action: request.action,
    state: status.state,
    step,
    total,
    ...(request.label ? { label: request.label } : {}),
  };

  if (status.state === 'failed') {
    return {
      title: `${subject}${action}失败`,
      body: status.message ?? `${action}未完成，请重试`,
      status: 'error',
      progress: 100,
      data,
    };
  }
  if (status.state === 'succeeded') {
    return {
      title: `${subject}${action}完成`,
      body: status.message ?? `${action}结果已生效`,
      status: 'success',
      progress: 100,
      data,
    };
  }

  const detail = status.detail ?? (status.state === 'pending' ? STEPS.pending : STEPS.processing);
  const stepHint = total > 0 ? `${detail}（第 ${step}/${total} 步）` : detail;
  return {
    title: `${action}中：${subject}`,
    body: stepHint,
    status: 'active',
    progress: progressValue(status),
    data,
  };
}

export interface FrontendApplyNotifierOptions {
  notifications: NotificationsService;
  logger?: { warn: (message: string) => void };
  /** Frontend deep link opened from the bell. Defaults to the plugin console. */
  link?: string;
}

/**
 * Build the notifier the builder calls at each progress point. It is a no-op
 * when the apply has no known actor (`requestedBy` null) — e.g. the boot
 * reconcile, which must not spam a user's inbox. Failures are logged, never
 * thrown: a notification is best-effort and must not fail the build.
 */
export function createFrontendApplyNotifier(
  options: FrontendApplyNotifierOptions,
): FrontendApplyNotifier {
  return async (request, status) => {
    if (!request.requestedBy) return;
    const content = frontendApplyNotification(request, status);
    try {
      await options.notifications.upsert({
        userId: request.requestedBy,
        dedupeKey: FRONTEND_APPLY_NOTIFICATION_KEY,
        type: 'system.frontend-apply',
        title: content.title,
        body: content.body,
        link: options.link ?? '/admin/plugins',
        data: content.data,
        status: content.status,
        progress: content.progress,
      });
    } catch (error) {
      options.logger?.warn(
        `[frontend-apply] 写入实况通知失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

/**
 * Emit the initial `pending` live notification as soon as a request is written,
 * so the bell reflects the activity immediately (and still does when automated
 * build is disabled and the request would otherwise sit unprocessed). Falls back
 * to a fresh kernel notification service; the module imports are deferred to
 * keep `frontend-apply.ts` (a pure file/Redis module) free of DB coupling at
 * load time and off the test path.
 */
export async function notifyFrontendApplyQueued(request: FrontendApplyRequest): Promise<void> {
  if (!request.requestedBy) return;
  const [{ getPrisma }, { getEventBus }, { KernelNotificationsService }] = await Promise.all([
    import('../plugins/prisma.ts'),
    import('../plugins/events.ts'),
    import('./notifications-service.ts'),
  ]);
  const notifier = createFrontendApplyNotifier({
    notifications: new KernelNotificationsService({ db: getPrisma(), events: getEventBus() }),
  });
  await notifier(request, {
    state: 'pending',
    requestedAt: request.requestedAt,
    ...(request.label ? { label: request.label } : {}),
    target: request.target,
    action: request.action,
    step: 1,
    ...(request.steps ? { steps: request.steps } : {}),
  });
}
