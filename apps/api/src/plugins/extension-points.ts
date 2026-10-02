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
];
