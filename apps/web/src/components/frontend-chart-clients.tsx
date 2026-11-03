'use client';

/**
 * Host-absorbed chart capabilities.
 *
 * Runtime-loaded plugin frontends cannot mint their own client references, and
 * `@stackpanel/ui/charts` cannot be evaluated in the RSC server graph because
 * Recharts calls `React.createContext` at module scope. This module is bundled
 * by Next/Turbopack, so these exports are real client references the host
 * renderer can hydrate; `frontend-host-abi.ts` republishes them for the loader.
 *
 * Only components that are actually rendered pull the Recharts chunk in.
 */
export { MetricsExplorer, UsageTrendChart } from '@stackpanel/ui/charts';
