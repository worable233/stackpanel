/**
 * Pull-based metric collectors (ADR-0015 §2).
 *
 * Prometheus scrapes `/metrics`; some values are not push-updated on the hot
 * path (queue depth, outbox backlog) and are instead refreshed when a scrape
 * happens (or on a short cache TTL so a burst of scrapes does not hammer Redis
 * and the DB).
 *
 * The collector is intentionally tolerant: if Redis or the DB is briefly
 * unreachable, the affected gauges are left at their last value rather than
 * failing the scrape — an observability endpoint must never take down a monitor.
 */
import type { Metrics } from './metrics.ts';
import { getInfraConfig } from '../infra.ts';
import { jobQueueCounts } from '../jobs/index.ts';
import { getOutboxBus } from '../plugins/events.ts';

/** Minimum interval between two refreshes triggered by scrapes. */
const REFRESH_TTL_MS = 5_000;

export interface MetricsCollector {
  /** Refresh pull gauges (respects the cache TTL unless `force`). */
  refresh(force?: boolean): Promise<void>;
}

/**
 * Build a collector bound to the given metrics registry. It uses the process
 * infra singletons (Redis URL, outbox bus), so it is only meaningful after
 * `initInfra()` has run.
 */
export function createMetricsCollector(metrics: Metrics): MetricsCollector {
  let lastRefresh = 0;
  let inFlight: Promise<void> | null = null;

  async function collectQueueDepth(): Promise<void> {
    const redisUrl = getInfraConfig().redisUrl ?? null;
    const counts = await jobQueueCounts(redisUrl);
    if (!counts) return;
    for (const [state, value] of Object.entries(counts)) {
      metrics.jobQueueDepth.set({ state }, value);
    }
  }

  async function collectOutboxBacklog(): Promise<void> {
    const pending = await getOutboxBus().pendingCount();
    metrics.outboxBacklog.set(pending);
  }

  return {
    async refresh(force = false): Promise<void> {
      const now = Date.now();
      if (!force && now - lastRefresh < REFRESH_TTL_MS) return;
      // Coalesce concurrent scrapes into one collection pass.
      if (inFlight) return inFlight;
      lastRefresh = now;
      inFlight = (async () => {
        try {
          await Promise.all([
            collectQueueDepth().catch(() => undefined),
            collectOutboxBacklog().catch(() => undefined),
          ]);
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}
