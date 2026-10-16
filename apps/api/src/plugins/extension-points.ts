import { EXTENSION_POINTS } from '@stackpanel/sdk';
import type { ExtensionPointId } from '@stackpanel/sdk';

/**
 * Kernel-provided extension points. Plugins register implementations via
 * `ctx.registerExtension(pointId, impl)`; the kernel consumes them.
 */
export const KERNEL_EXTENSION_POINTS: readonly ExtensionPointId[] = [
  EXTENSION_POINTS.routes,
  EXTENSION_POINTS.authProvider,
  EXTENSION_POINTS.paymentProvider,
  EXTENSION_POINTS.paymentSettlement,
  EXTENSION_POINTS.eventListener,
  EXTENSION_POINTS.webNav,
  EXTENSION_POINTS.adminDashboard,
  // 模型供给扩展点（PLAN-agent-in-kernel §3.1/§3.6）。插件在此注册 `LlmProvider`，
  // 内核经 `resolveLlmProvider` 取第一个实现（apps/api/src/lib/llm-provider.ts）。
  EXTENSION_POINTS.llmProvider,
  // 存储供给扩展点（ADR-0014 扩展）。插件在此注册 `StorageProvider`，内核经
  // `resolveStorageDriver` 取第一个实现（apps/api/src/storage/provider-router.ts）。
  EXTENSION_POINTS.storageProvider,
  // 通知外部渠道扩展点。插件在此注册通知渠道，订阅 `notification.created`。
  EXTENSION_POINTS.notificationChannel,
  // 验证码发送渠道扩展点（审计 §5）。插件在此注册 `IdentityChallengeSender`，
  // 内核 `ctx.identity` 经此投递注册邮箱验证码（与站内通知渠道刻意分离）。
  EXTENSION_POINTS.identityChallengeSender,
  // 人机验证扩展点（审计 §5）。插件在此注册 `CaptchaProvider`，内核 `ctx.captcha` 消费。
  EXTENSION_POINTS.captchaProvider,
];
