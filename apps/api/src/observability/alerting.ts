/**
 * In-process alert evaluation (ADR-0015 §7, best-effort).
 *
 * Prometheus is the real alerting authority (see {@link ALERT_RULES}); this job
 * gives an early-warning signal to deployments that scrape `/metrics` but have
 * not yet loaded the rules file. It refreshes the pull gauges, evaluates the
 * snapshot-derivable rules, and logs on **state transitions** so a steady firing
 * condition does not spam logs every interval.
 *
 * It runs as a kernel job (ADR-0013) so a multi-replica cluster evaluates once.
 */
import type { JobContext } from '@stackpanel/sdk';
import { getMetrics } from './metrics.ts';
import type { MetricsCollector } from './collector.ts';
import { evaluateAlerts, snapshotAlertInputs, type AlertEvaluation } from './alerts.ts';

/** Alert job name (the kernel qualifies it to `kernel.observability.alerts`). */
export const ALERT_JOB = 'observability.alerts';

/** One minute is a good balance between responsiveness and log noise. */
export const ALERT_INTERVAL_MS = 60_000;

export interface RegisterAlertingOptions {
  logger?: { warn: (message: string) => void; info?: (message: string) => void };
  intervalMs?: number;
  /** Collector used to refresh pull gauges before evaluating. */
  collector?: MetricsCollector;
}

/**
 * Diff against the last firing set and log only transitions. Returns the
 * currently-firing evaluations (exposed for tests).
 */
export function diffAlerts(
  previous: ReadonlySet<string>,
  evaluations: readonly AlertEvaluation[],
): { firing: AlertEvaluation[]; opened: AlertEvaluation[]; cleared: string[] } {
  const firing = evaluations.filter((evaluation) => evaluation.firing);
  const firingNames = new Set(firing.map((evaluation) => evaluation.name));
  const opened = firing.filter((evaluation) => !previous.has(evaluation.name));
  const cleared = [...previous].filter((name) => !firingNames.has(name));
  return { firing, opened, cleared };
}

export async function registerAlerting(
  jobs: JobContext,
  options: RegisterAlertingOptions = {},
): Promise<void> {
  let previous: Set<string> = new Set();

  jobs.handle(ALERT_JOB, async () => {
    try {
      await options.collector?.refresh();
      const evaluations = evaluateAlerts(await snapshotAlertInputs(getMetrics()));
      const { firing, opened, cleared } = diffAlerts(previous, evaluations);
      for (const alert of opened) {
        options.logger?.warn(
          `[alert] ${alert.severity.toUpperCase()} ${alert.name} 触发：${alert.observed}`,
        );
      }
      for (const name of cleared) {
        options.logger?.info?.(`[alert] ${name} 已恢复`);
      }
      previous = new Set(firing.map((evaluation) => evaluation.name));
    } catch (err) {
      // Observability must never take down the job runtime.
      options.logger?.warn(`[alert] 评估失败：${String(err)}`);
    }
  });

  await jobs.schedule(ALERT_JOB, { everyMs: options.intervalMs ?? ALERT_INTERVAL_MS });
}
