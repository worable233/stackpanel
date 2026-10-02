/**
 * Prometheus metrics registry (ADR-0015 §2).
 *
 * A dedicated {@link Registry} (not the global default) keeps the kernel's
 * metric surface explicit and lets tests build an isolated one. The default
 * Node process metrics are collected under the `stackpanel_` prefix.
 *
 * Cardinality is deliberately bounded: HTTP labels are the route template
 * (`request.routeOptions.url`, e.g. `/api/v1/platform`) rather than the raw URL,
 * so an unbounded set of ids or query strings cannot blow up the series count.
 * Unmatched paths collapse to a single `unmatched` label.
 */
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

/** Latency buckets in seconds, tuned for an HTTP API (5ms .. 10s). */
const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** The metric instruments the kernel records into. */
export interface Metrics {
  registry: Registry;
  /** Total HTTP requests by method / route template / status class. */
  httpRequestsTotal: Counter<'method' | 'route' | 'status'>;
  /** HTTP request latency in seconds by method / route template / status. */
  httpRequestDurationSeconds: Histogram<'method' | 'route' | 'status'>;
  /** In-flight HTTP requests by method. */
  httpRequestsInFlight: Gauge<'method'>;
  /** Requests rejected by a limiter, by scope (`http`, `open_api_token`). */
  rateLimitRejectionsTotal: Counter<'scope'>;
  /** BullMQ queue depth by state (waiting / active / delayed / failed / completed). */
  jobQueueDepth: Gauge<'state'>;
  /** Undelivered outbox rows awaiting relay (crash-recovery backlog). */
  outboxBacklog: Gauge<string>;
}

export interface CreateMetricsOptions {
  /** Collect Node process/runtime default metrics. Off for isolated tests. */
  defaultMetrics?: boolean;
}

/** Build an isolated metrics bundle. */
export function createMetrics(options: CreateMetricsOptions = {}): Metrics {
  const registry = new Registry();
  if (options.defaultMetrics ?? true) {
    collectDefaultMetrics({ register: registry, prefix: 'stackpanel_' });
  }

  const httpRequestsTotal = new Counter({
    name: 'stackpanel_http_requests_total',
    help: 'HTTP 请求总数（按方法 / 路由模板 / 状态）',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });
  const httpRequestDurationSeconds = new Histogram({
    name: 'stackpanel_http_request_duration_seconds',
    help: 'HTTP 请求耗时（秒）',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: HTTP_DURATION_BUCKETS,
    registers: [registry],
  });
  const httpRequestsInFlight = new Gauge({
    name: 'stackpanel_http_requests_in_flight',
    help: '正在处理的 HTTP 请求数',
    labelNames: ['method'] as const,
    registers: [registry],
  });
  const rateLimitRejectionsTotal = new Counter({
    name: 'stackpanel_rate_limit_rejections_total',
    help: '被限流拒绝的请求数（按作用域）',
    labelNames: ['scope'] as const,
    registers: [registry],
  });
  const jobQueueDepth = new Gauge({
    name: 'stackpanel_job_queue_depth',
    help: 'BullMQ 队列深度（按状态）',
    labelNames: ['state'] as const,
    registers: [registry],
  });
  const outboxBacklog = new Gauge({
    name: 'stackpanel_outbox_backlog',
    help: '未投递的 outbox 事件数',
    registers: [registry],
  });

  return {
    registry,
    httpRequestsTotal,
    httpRequestDurationSeconds,
    httpRequestsInFlight,
    rateLimitRejectionsTotal,
    jobQueueDepth,
    outboxBacklog,
  };
}

let singleton: Metrics | null = null;

/** The process-wide metrics bundle. */
export function getMetrics(): Metrics {
  if (!singleton) singleton = createMetrics();
  return singleton;
}

/** Prometheus text exposition content type. */
export function metricsContentType(): string {
  return getMetrics().registry.contentType;
}

/** Render the process-wide metrics in Prometheus text format. */
export function renderMetrics(): Promise<string> {
  return getMetrics().registry.metrics();
}
