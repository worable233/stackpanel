/**
 * Alert rules and SLO definitions (ADR-0015 §7).
 *
 * Prometheus is the alerting authority (ADR-0015 explicitly rules out hosting a
 * rules platform), so the canonical rules are defined **once** here — as
 * structured data with PromQL — and rendered to a Prometheus rules file that
 * operators load. Keeping the rules in code means they version with the metric
 * names they reference and can be unit-tested.
 *
 * On top of that, a small **in-process evaluator** gives operators who have not
 * stood up Prometheus an early warning surface: the alerting kernel job logs
 * when a condition fires and when it clears. It is deliberately conservative —
 * it only evaluates the subset that is derivable from the registry (gauges and
 * cumulative ratios) and never pretends to replace windowed PromQL rates.
 *
 * SLOs are the human-facing contract (availability, latency, async delivery);
 * each alert rule that guards one links back via `slo`.
 */
import type { Metrics } from './metrics.ts';

export type AlertSeverity = 'critical' | 'warning';

/** A Prometheus alert rule, renderable to a rules file. */
export interface AlertRule {
  /** Prometheus alert name (also the in-process evaluation id). */
  name: string;
  severity: AlertSeverity;
  /** PromQL expression that fires when true. */
  expr: string;
  /** Prometheus `for:` duration. */
  for: string;
  /** One-line alert summary (Chinese, matching the UI/log convention). */
  summary: string;
  /** Longer description with the operator action. */
  description: string;
  /** Related SLO id, when this rule guards one. */
  slo?: string;
}

/** A service-level objective backed by a PromQL indicator. */
export interface Slo {
  id: string;
  title: string;
  /** Objective, e.g. `99.9% / 30d`. */
  objective: string;
  /** PromQL service-level indicator. */
  sli: string;
  /** Budget the objective implies, when meaningful. */
  errorBudget?: string;
  notes: string;
}

/**
 * The minimum SLO set (ADR-0015 §7). Availability and latency are user-visible
 * contracts; async delivery covers the outbox/queue path.
 */
export const SLOS: readonly Slo[] = [
  {
    id: 'api.availability',
    title: 'API 可用性',
    objective: '99.9% / 30d',
    sli:
      '1 - (sum(rate(stackpanel_http_requests_total{status="5xx"}[30d])) ' +
      '/ clamp_min(sum(rate(stackpanel_http_requests_total[30d])), 1e-9))',
    errorBudget: '每月约 43 分钟不可用预算',
    notes: '5xx 计入违约；4xx 是客户端错误，不计入。',
  },
  {
    id: 'api.latency',
    title: 'API 延迟',
    objective: 'P95 < 500ms / 30d',
    sli:
      'histogram_quantile(0.95, sum by (le) (rate(stackpanel_http_request_duration_seconds_bucket[30d])))',
    notes: '按全部路由合计；单路由劣化用 HighLatencyP95 告警定位。',
  },
  {
    id: 'async.delivery',
    title: '异步投递积压',
    objective: 'outbox 积压 < 500 的时间占比 ≥ 99% / 30d',
    sli: 'max_over_time(stackpanel_outbox_backlog[30d])',
    notes: 'relay 停摆会让事件长期滞留；积压即告警。',
  },
];

/**
 * Alert rules over the metrics the kernel already exposes. Thresholds mirror the
 * SLO objectives above; `for:` is chosen so a single blip does not page.
 */
export const ALERT_RULES: readonly AlertRule[] = [
  {
    name: 'HighErrorRate',
    severity: 'critical',
    expr:
      'sum(rate(stackpanel_http_requests_total{status="5xx"}[5m])) ' +
      '/ clamp_min(sum(rate(stackpanel_http_requests_total[5m])), 1e-9) > 0.05',
    for: '5m',
    summary: 'HTTP 5xx 错误率超过 5%',
    description: '连续 5 分钟服务端错误率 > 5%，可能已突破可用性 SLO。检查最近发布与下游依赖。',
    slo: 'api.availability',
  },
  {
    name: 'HighLatencyP95',
    severity: 'warning',
    expr:
      'histogram_quantile(0.95, sum by (le) ' +
      '(rate(stackpanel_http_request_duration_seconds_bucket[5m]))) > 0.5',
    for: '10m',
    summary: 'HTTP P95 延迟超过 500ms',
    description: '连续 10 分钟 P95 延迟 > 500ms；定位慢路由 / DB / 外部依赖。',
    slo: 'api.latency',
  },
  {
    name: 'RateLimitSpike',
    severity: 'warning',
    expr: 'sum(rate(stackpanel_rate_limit_rejections_total[5m])) > 10',
    for: '10m',
    summary: '限流拒绝速率异常',
    description: '持续每秒 > 10 次限流拒绝；可能是刷量攻击或配额配置过紧。',
  },
  {
    name: 'QueueBacklog',
    severity: 'warning',
    expr: 'max(stackpanel_job_queue_depth{state="waiting"}) > 1000',
    for: '10m',
    summary: 'BullMQ 等待队列积压',
    description: '等待任务持续 > 1000；检查 worker 是否存活或任务是否卡死。',
  },
  {
    name: 'OutboxBacklog',
    severity: 'warning',
    expr: 'max(stackpanel_outbox_backlog) > 500',
    for: '10m',
    summary: 'outbox 事件积压',
    description: '未投递事件持续 > 500；relay 可能停摆，异步链路会延迟。',
    slo: 'async.delivery',
  },
  {
    name: 'ApiDown',
    severity: 'critical',
    expr: 'up{job="stackpanel-api"} == 0',
    for: '2m',
    summary: 'API 实例不可达',
    description: 'Prometheus 连续 2 分钟抓不到实例；检查进程、LB 与网络。',
    slo: 'api.availability',
  },
];

/** Escaped YAML scalar (rules contain `{`, `"` and `%`). */
function yaml(s: string): string {
  return JSON.stringify(s);
}

/** Render the canonical rules as a Prometheus rules file (`groups:`). */
export function renderPrometheusRules(): string {
  const lines: string[] = [
    '# 由 @stackpanel/api observability/alerts.ts 生成，请勿手工编辑。',
    'groups:',
    '  - name: stackpanel',
    '    rules:',
  ];
  for (const rule of ALERT_RULES) {
    lines.push(`      - alert: ${rule.name}`);
    lines.push(`        expr: ${yaml(rule.expr)}`);
    lines.push(`        for: ${rule.for}`);
    lines.push('        labels:');
    lines.push(`          severity: ${rule.severity}`);
    lines.push('        annotations:');
    lines.push(`          summary: ${yaml(rule.summary)}`);
    lines.push(`          description: ${yaml(rule.description)}`);
    if (rule.slo) lines.push(`          slo: ${rule.slo}`);
  }
  return `${lines.join('\n')}\n`;
}

// --- In-process evaluation (subset) ----------------------------------------

/** A plain snapshot of the registry, decoupled from prom-client for testing. */
export interface AlertInputs {
  totalRequests: number;
  serverErrors: number;
  latencyObservations: number;
  /** Approximate P95 in seconds over the whole (cumulative) histogram. */
  latencyP95Seconds: number;
  /** Queue depth by state, as last collected. */
  queueWaiting: number;
  outboxBacklog: number;
}

/** The outcome of evaluating one rule against {@link AlertInputs}. */
export interface AlertEvaluation {
  name: string;
  severity: AlertSeverity;
  firing: boolean;
  /** Human-readable observed value vs threshold (for logs). */
  observed: string;
}

interface RegistryJson {
  name: string;
  type?: string;
  values: Array<{ metricName?: string; labels: Record<string, string> | null; value: number }>;
}

/** Read the registry snapshot (prom-client's `getMetricsAsJSON` is async). */
export async function snapshotAlertInputs(metrics: Metrics): Promise<AlertInputs> {
  const json = (await (
    metrics.registry as unknown as { getMetricsAsJSON: () => Promise<RegistryJson[]> }
  ).getMetricsAsJSON()) as RegistryJson[];
  const find = (name: string): RegistryJson | undefined => json.find((entry) => entry.name === name);

  const requests = find('stackpanel_http_requests_total');
  let totalRequests = 0;
  let serverErrors = 0;
  for (const value of requests?.values ?? []) {
    totalRequests += value.value;
    if (value.labels?.status === '5xx') serverErrors += value.value;
  }

  const histogram = find('stackpanel_http_request_duration_seconds');
  let observations = 0;
  let p95 = 0;
  if (histogram) {
    const isBucket = (value: { metricName?: string; labels: Record<string, string> | null }): boolean =>
      value.metricName?.endsWith('_bucket') === true || Boolean(value.labels && 'le' in value.labels);
    const buckets = histogram.values
      .filter(isBucket)
      .map((value) => ({ le: Number(value.labels?.le), count: value.value }))
      .filter((bucket) => Number.isFinite(bucket.le))
      .sort((a, b) => a.le - b.le);
    // `_count` is the total observations (prom-client names it explicitly).
    const countSeries = histogram.values.find(
      (value) => value.metricName?.endsWith('_count') === true,
    );
    observations = countSeries?.value ?? buckets.at(-1)?.count ?? 0;
    if (observations > 0) {
      const target = observations * 0.95;
      const bucket = buckets.find((candidate) => candidate.count >= target);
      p95 = bucket ? bucket.le : (buckets.at(-1)?.le ?? 0);
    }
  }

  const queue = find('stackpanel_job_queue_depth');
  const queueWaiting =
    queue?.values.find((value) => value.labels?.state === 'waiting')?.value ?? 0;

  const outbox = find('stackpanel_outbox_backlog');
  const outboxBacklog = outbox?.values[0]?.value ?? 0;

  return {
    totalRequests,
    serverErrors,
    latencyObservations: observations,
    latencyP95Seconds: p95,
    queueWaiting,
    outboxBacklog,
  };
}

/** Minimum samples before ratio-based rules fire, so a cold start is quiet. */
const MIN_RATIO_SAMPLES = 20;

/**
 * Evaluate the subset of rules derivable from a cumulative snapshot. Rate-based
 * rules that need a windowed PromQL expression (RateLimitSpike, ApiDown) are not
 * evaluated here and are intentionally absent from the result — Prometheus owns
 * them.
 */
export function evaluateAlerts(inputs: AlertInputs): AlertEvaluation[] {
  const evaluations: AlertEvaluation[] = [];

  const errorRatio =
    inputs.totalRequests > 0 ? inputs.serverErrors / inputs.totalRequests : 0;
  evaluations.push({
    name: 'HighErrorRate',
    severity: 'critical',
    firing: inputs.totalRequests >= MIN_RATIO_SAMPLES && errorRatio > 0.05,
    observed: `${(errorRatio * 100).toFixed(2)}%（${inputs.serverErrors}/${inputs.totalRequests}）`,
  });

  evaluations.push({
    name: 'HighLatencyP95',
    severity: 'warning',
    firing: inputs.latencyObservations >= MIN_RATIO_SAMPLES && inputs.latencyP95Seconds > 0.5,
    observed: `${(inputs.latencyP95Seconds * 1000).toFixed(0)}ms（n=${inputs.latencyObservations}）`,
  });

  evaluations.push({
    name: 'QueueBacklog',
    severity: 'warning',
    firing: inputs.queueWaiting > 1000,
    observed: `${inputs.queueWaiting} waiting`,
  });

  evaluations.push({
    name: 'OutboxBacklog',
    severity: 'warning',
    firing: inputs.outboxBacklog > 500,
    observed: `${inputs.outboxBacklog} pending`,
  });

  return evaluations;
}
