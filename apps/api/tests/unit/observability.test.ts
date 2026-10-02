import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { trace } from '@opentelemetry/api';
import { createMetrics, metricsContentType } from '../../src/observability/metrics.ts';
import { createMetricsCollector } from '../../src/observability/collector.ts';
import { installHttpMetrics } from '../../src/observability/http-metrics.ts';
import { metricsRoutes } from '../../src/routes/metrics.ts';
import { startTracing, stopTracing, isTracingEnabled } from '../../src/observability/tracing.ts';
import { pruneAuditLogs } from '../../src/observability/audit-retention.ts';
import { installObservability } from '../../src/observability/index.ts';
import { getJobRuntime } from '../../src/jobs/kernel-jobs.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';

/**
 * Observability (ADR-0015): the Prometheus metric registry, the HTTP
 * instrumentation, the `/metrics` access policy, audit retention, and the OTel
 * bootstrap. All hermetic except audit retention, which touches the test DB.
 */

describe('metrics registry', () => {
  it('renders counters and histograms with the stackpanel prefix', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    metrics.httpRequestsTotal.inc({ method: 'GET', route: '/x', status: '2xx' });
    metrics.httpRequestDurationSeconds.observe({ method: 'GET', route: '/x', status: '2xx' }, 0.02);
    metrics.rateLimitRejectionsTotal.inc({ scope: 'http' });

    const text = await metrics.registry.metrics();
    expect(text).toContain('stackpanel_http_requests_total');
    expect(text).toContain('stackpanel_http_request_duration_seconds_bucket');
    expect(text).toContain('stackpanel_rate_limit_rejections_total');
    // Isolated registry: no default Node process metrics leak in.
    expect(text).not.toContain('process_cpu_seconds_total');
  });
});

describe('HTTP metrics instrumentation', () => {
  let app: FastifyInstance;
  const metrics = createMetrics({ defaultMetrics: false });

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(rateLimit, { global: false });
    installHttpMetrics(app, metrics);
    app.get('/probe/:id', async () => ({ ok: true }));
    app.get('/metrics', async () => 'raw');
    app.post('/limited', { config: { rateLimit: { max: 0, timeWindow: '1 minute' } } }, async () => ({
      ok: true,
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('counts a request under its route template, not the raw URL', async () => {
    const before = await counterValue(metrics, {
      method: 'GET',
      route: '/probe/:id',
      status: '2xx',
    });
    await app.inject({ method: 'GET', url: '/probe/abc-123' });
    const after = await counterValue(metrics, {
      method: 'GET',
      route: '/probe/:id',
      status: '2xx',
    });
    expect(after).toBe(before + 1);
    // The concrete id never becomes a label.
    const text = await metrics.registry.metrics();
    expect(text).not.toContain('route="/probe/abc-123"');
  });

  it('records the latency histogram', async () => {
    await app.inject({ method: 'GET', url: '/probe/1' });
    const text = await metrics.registry.metrics();
    expect(text).toContain('stackpanel_http_request_duration_seconds_count');
  });

  it('excludes the scrape endpoint itself', async () => {
    const before = await scalar(metrics, 'stackpanel_http_requests_total');
    await app.inject({ method: 'GET', url: '/metrics' });
    const after = await scalar(metrics, 'stackpanel_http_requests_total');
    expect(after).toBe(before);
  });

  it('counts rate-limit denials through the final status', async () => {
    const res = await app.inject({ method: 'POST', url: '/limited' });
    expect(res.statusCode).toBe(429);
    const scope = await counterValue(metrics, { scope: 'http' }, 'stackpanel_rate_limit_rejections_total');
    expect(scope).toBeGreaterThan(0);
  });
});

describe('/metrics access policy', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(metricsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves Prometheus text to loopback callers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('stackpanel_http_requests_total');
  });

  it('hides the endpoint from non-loopback callers when no token is set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '203.0.113.9',
    });
    expect(res.statusCode).toBe(404);
  });

  it('reports the Prometheus content type', () => {
    expect(metricsContentType()).toContain('text/plain');
  });
});

describe('audit retention (ADR-0015 §5)', () => {
  it('prunes rows older than the window and keeps recent ones', async () => {
    const prisma = getPrisma();
    const marker = `obs-test-${Date.now()}`;
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await prisma.auditLog.create({
      data: { action: marker, resource: 'obs', createdAt: oldDate },
    });
    const recent = await prisma.auditLog.create({
      data: { action: marker, resource: 'obs' },
    });

    const removed = await pruneAuditLogs(1);
    expect(removed).toBeGreaterThanOrEqual(1);

    const remaining = await prisma.auditLog.findMany({ where: { action: marker } });
    expect(remaining.map((row) => row.id)).toEqual([recent.id]);
    await prisma.auditLog.deleteMany({ where: { action: marker } });
  });

  it('is a no-op when retention is disabled (0 days)', async () => {
    expect(await pruneAuditLogs(0)).toBe(0);
  });
});

describe('tracing bootstrap', () => {
  afterAll(async () => {
    await stopTracing();
  });

  it('stays off unless configured', () => {
    expect(isTracingEnabled()).toBe(false);
  });

  it('starts with an explicit endpoint and contains exporter failures', async () => {
    const started = startTracing({
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
      serviceName: 'stackpanel-api-test',
    });
    expect(started).toBe(true);
    expect(isTracingEnabled()).toBe(true);

    // A span that will fail to export must not crash the process.
    trace.getTracer('test').startSpan('probe').end();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isTracingEnabled()).toBe(true);
  });
});

describe('installObservability one-line wiring', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    installObservability(app);
    app.get('/wired', async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers the /metrics route and records a handled request', async () => {
    await app.inject({ method: 'GET', url: '/wired' });
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('stackpanel_http_requests_total');
    expect(res.body).toContain('route="/wired"');
  });

  it('schedules the audit-retention kernel job on the canonical runtime', () => {
    // The full name is namespaced by the kernel owner.
    const names = getJobRuntime().listSchedules();
    expect(names).toContain('kernel.audit.retention');
  });
});

describe('metrics collector (pull gauges)', () => {
  it('reads outbox backlog and queue depth through the collector', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    const collector = createMetricsCollector(metrics);

    await collector.refresh(true);

    const json = (await metrics.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ labels: Record<string, string>; value: number }>;
    }>;
    // The outbox backlog gauge is always set; queue depth is populated when
    // Redis is configured (the test run supplies REDIS_URL).
    expect(json.some((entry) => entry.name === 'stackpanel_outbox_backlog')).toBe(true);
    if (process.env.REDIS_URL) {
      const depth = json.find((entry) => entry.name === 'stackpanel_job_queue_depth');
      expect(depth).toBeDefined();
      expect(depth?.values.some((value) => value.labels.state === 'waiting')).toBe(true);
    }
  });

  it('coalesces rapid refreshes (TTL guard)', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    const collector = createMetricsCollector(metrics);
    await collector.refresh(true);
    // A second non-forced refresh within the TTL is a no-op and must not throw.
    await expect(collector.refresh()).resolves.toBeUndefined();
  });
});

/** Read one labelled counter value (0 when the series does not exist yet). */
async function counterValue(
  metrics: ReturnType<typeof createMetrics>,
  labels: Record<string, string>,
  name = 'stackpanel_http_requests_total',
): Promise<number> {
  const json = (await metrics.registry.getMetricsAsJSON()) as Array<{
    name: string;
    values: Array<{ labels: Record<string, string>; value: number }>;
  }>;
  const metric = json.find((entry) => entry.name === name);
  if (!metric) return 0;
  const series = metric.values.find((value) =>
    Object.entries(labels).every(([key, expected]) => value.labels[key] === expected),
  );
  return series?.value ?? 0;
}

/** Sum every series of a counter. */
async function scalar(
  metrics: ReturnType<typeof createMetrics>,
  name: string,
): Promise<number> {
  const json = (await metrics.registry.getMetricsAsJSON()) as Array<{
    name: string;
    values: Array<{ value: number }>;
  }>;
  const metric = json.find((entry) => entry.name === name);
  if (!metric) return 0;
  return metric.values.reduce((sum, value) => sum + value.value, 0);
}
