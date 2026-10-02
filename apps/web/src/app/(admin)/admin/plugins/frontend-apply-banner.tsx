'use client';

import type { FrontendApplyStatus } from '@stackpanel/sdk';
import {
  FrontendApplyProgress,
  isFrontendApplyActive,
  useFrontendApplyStatus,
} from './frontend-apply-progress';

/**
 * Shows the progress of an in-flight plugin/theme frontend apply and, once it
 * settles, refreshes so the newly built pages become visible automatically.
 */
export function FrontendApplyBanner({
  initialStatus,
}: {
  initialStatus: FrontendApplyStatus | null;
}) {
  const status = useFrontendApplyStatus(initialStatus);

  if (!status) return null;
  // Keep the last successful result visible only while something is happening;
  // a stale "succeeded" card would otherwise linger after a page refresh.
  if (!isFrontendApplyActive(status) && status.state === 'succeeded') return null;

  return <FrontendApplyProgress status={status} />;
}
