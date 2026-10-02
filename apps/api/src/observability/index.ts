/**
 * Observability subsystem entry points (ADR-0015).
 *
 * Two independent surfaces:
 *   - **Metrics** (Prometheus): {@link getMetrics} / {@link installHttpMetrics}
 *     record on the hot path, {@link getMetricsCollector} refreshes pull gauges,
 *     and the `/metrics` route renders them.
 *   - **Tracing** (OTel): {@link startTracing} installs the SDK before the app
 *     is built; web→API calls continue the same trace via `traceparent`.
 *
 * Nothing here mutates business behaviour: instrumentation wraps, it does not
 * intercept. Everything is a no-op unless configured.
 */
import { getMetrics, type Metrics } from './metrics.ts';
import { createMetricsCollector, type MetricsCollector } from './collector.ts';
import { installHttpMetrics } from './http-metrics.ts';
import { metricsRoutes } from '../routes/metrics.ts';
import { registerAuditRetention } from './audit-retention.ts';
import { registerAlerting } from './alerting.ts';
import { createKernelJobContext, getJobRuntime } from '../jobs/kernel-jobs.ts';
export { getMetrics, createMetrics, renderMetrics, metricsContentType } from './metrics.ts';
export type { Metrics, CreateMetricsOptions } from './metrics.ts';
export { createMetricsCollector } from './collector.ts';
export type { MetricsCollector } from './collector.ts';
export { installHttpMetrics } from './http-metrics.ts';
export { metricsRoutes } from '../routes/metrics.ts';
export { pruneAuditLogs, registerAuditRetention, AUDIT_RETENTION_JOB } from './audit-retention.ts';
export {
  SLOS,
  ALERT_RULES,
  renderPrometheusRules,
  evaluateAlerts,
  snapshotAlertInputs,
} from './alerts.ts';
export type { AlertRule, AlertSeverity, AlertEvaluation, AlertInputs, Slo } from './alerts.ts';
export { registerAlerting, diffAlerts, ALERT_JOB } from './alerting.ts';
export {
  startTracing,
  stopTracing,
  isTracingEnabled,
  activeSpan,
  currentTraceId,
} from './tracing.ts';
export type { StartTracingOptions } from './tracing.ts';

let collector: MetricsCollector | null = null;

/** The process-wide metrics collector, bound to the process-wide registry. */
export function getMetricsCollector(): MetricsCollector {
  if (!collector) collector = createMetricsCollector(getMetrics());
  return collector;
}

/**
 * One-line kernel wiring for this stream (KERNEL appends this inside
 * `buildApp()`, before the app becomes ready):
 *
 * ```ts
 * import { installObservability } from './observability/index.ts';
 * // ...
 * installObservability(app);
 * ```
 *
 * It installs the HTTP metrics hooks, registers the `/metrics` route, and
 * schedules the audit-retention kernel job. All three are idempotent and each
 * self-disables when its env flag does. Tracing is separate because it must run
 * before `buildApp()`: call {@link startTracing} from the entrypoints.
 */
export function installObservability(app: Parameters<typeof installHttpMetrics>[0]): void {
  installHttpMetrics(app, getMetrics());
  void app.register(metricsRoutes);
  // Audit retention runs as a kernel job (ADR-0015 §5 / ADR-0013), registered
  // on the canonical job runtime exactly like the other kernel sweeps.
  const kernelJobs = createKernelJobContext('kernel', getJobRuntime());
  void registerAuditRetention(kernelJobs, {
    logger: { warn: (message) => app.log.warn(message) },
  });
  // Alert evaluation runs as a kernel job too (ADR-0015 §7); it is a best-effort
  // early warning, Prometheus stays the alerting authority.
  void registerAlerting(kernelJobs, {
    logger: { warn: (message) => app.log.warn(message), info: (message) => app.log.info(message) },
    collector: getMetricsCollector(),
  });
}

/** The process-wide metrics bundle (re-exported for callers that need both). */
export function observabilityRegistry(): Metrics {
  return getMetrics();
}
