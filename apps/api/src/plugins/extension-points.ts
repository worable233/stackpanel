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
];
