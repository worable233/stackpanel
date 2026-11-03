'use client';

/**
 * Client entry for the metrics explorer.
 *
 * `@stackpanel/ui/charts` depends on Recharts, which cannot be imported into
 * the RSC server graph. The host loader swaps this module for a host-absorbed
 * client reference (see `frontend-host-abi.ts`), so `index.tsx` can render the
 * chart without evaluating Recharts on the server.
 */
export { MetricsExplorer } from '@stackpanel/ui/charts';
