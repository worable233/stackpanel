import { describe, expect, it } from 'vitest';
import {
  ALERT_RULES,
  SLOS,
  evaluateAlerts,
  renderPrometheusRules,
  snapshotAlertInputs,
  type AlertInputs,
} from '../../src/observability/alerts.ts';
import {
  ALERT_JOB,
  diffAlerts,
  registerAlerting,
} from '../../src/observability/alerting.ts';
import { createMetrics } from '../../src/observability/metrics.ts';

/**
 * Alert rules + SLO (ADR-0015 §7). The registry snapshot and rule evaluation are
 * hermetic; the job registration reuses the canonical kernel job runtime.
 */

describe('alert rules and SLOs', () => {
  it('defines a minimum SLO set covering availability, latency and async delivery', () => {
    const ids = SLOS.map((slo) => slo.id);
    expect(ids).toContain('api.availability');
    expect(ids).toContain('api.latency');
    expect(ids).toContain('async.delivery');
    for (const slo of SLOS) {
      expect(slo.objective.length).toBeGreaterThan(0);
      expect(slo.sli).toContain('stackpanel_');
    }
  });

  it('links alert rules to the SLOs they guard', () => {
    const names = ALERT_RULES.map((rule) => rule.name);
    expect(names).toContain('HighErrorRate');
    expect(names).toContain('HighLatencyP95');
    expect(names).toContain('OutboxBacklog');
    const errorRule = ALERT_RULES.find((rule) => rule.name === 'HighErrorRate');
    expect(errorRule?.slo).toBe('api.availability');
    expect(errorRule?.severity).toBe('critical');
  });

  it('renders a valid Prometheus rules file', () => {
    const yaml = renderPrometheusRules();
    expect(yaml).toContain('groups:');
    expect(yaml).toContain('alert: HighErrorRate');
    expect(yaml).toContain('severity: critical');
    expect(yaml).toContain('expr:');
    // Every alert contributes an `- alert:` entry.
    expect(yaml.match(/ {6}- alert:/g)?.length).toBe(ALERT_RULES.length);
  });
});

describe('snapshotAlertInputs', () => {
  it('extracts counters, histogram P95, queue depth and outbox backlog', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    metrics.httpRequestsTotal.inc({ method: 'GET', route: '/x', status: '2xx' });
    metrics.httpRequestsTotal.inc({ method: 'GET', route: '/x', status: '5xx' });
    metrics.httpRequestDurationSeconds.observe({ method: 'GET', route: '/x', status: '2xx' }, 0.02);
    metrics.httpRequestDurationSeconds.observe({ method: 'GET', route: '/x', status: '2xx' }, 3);
    metrics.jobQueueDepth.set({ state: 'waiting' }, 1_500);
    metrics.outboxBacklog.set(750);

    const inputs = await snapshotAlertInputs(metrics);
    expect(inputs.totalRequests).toBe(2);
    expect(inputs.serverErrors).toBe(1);
    expect(inputs.latencyObservations).toBe(2);
    // Two samples, one slow (3s) → P95 is the +Inf-adjacent upper bucket (> 0.5s).
    expect(inputs.latencyP95Seconds).toBeGreaterThan(0.5);
    expect(inputs.queueWaiting).toBe(1_500);
    expect(inputs.outboxBacklog).toBe(750);
  });

  it('is safe on an empty registry', async () => {
    const inputs = await snapshotAlertInputs(createMetrics({ defaultMetrics: false }));
    expect(inputs).toMatchObject({
      totalRequests: 0,
      serverErrors: 0,
      latencyObservations: 0,
      queueWaiting: 0,
      outboxBacklog: 0,
    });
  });
});

describe('evaluateAlerts', () => {
  function inputs(overrides: Partial<AlertInputs> = {}): AlertInputs {
    return {
      totalRequests: 0,
      serverErrors: 0,
      latencyObservations: 0,
      latencyP95Seconds: 0,
      queueWaiting: 0,
      outboxBacklog: 0,
      ...overrides,
    };
  }

  it('stays quiet during a cold start (too few ratio samples)', () => {
    const evaluations = evaluateAlerts(inputs({ totalRequests: 5, serverErrors: 5 }));
    const error = evaluations.find((evaluation) => evaluation.name === 'HighErrorRate');
    expect(error?.firing).toBe(false);
  });

  it('fires on a high error ratio with enough samples', () => {
    const evaluations = evaluateAlerts(inputs({ totalRequests: 100, serverErrors: 10 }));
    expect(evaluations.find((e) => e.name === 'HighErrorRate')?.firing).toBe(true);
  });

  it('fires on latency, queue backlog and outbox backlog', () => {
    const evaluations = evaluateAlerts(
      inputs({
        latencyObservations: 100,
        latencyP95Seconds: 0.8,
        queueWaiting: 1_200,
        outboxBacklog: 600,
      }),
    );
    const firing = evaluations.filter((evaluation) => evaluation.firing).map((e) => e.name);
    expect(firing).toEqual(
      expect.arrayContaining(['HighLatencyP95', 'QueueBacklog', 'OutboxBacklog']),
    );
  });

  it('reports the observed value for operators', () => {
    const evaluations = evaluateAlerts(inputs({ totalRequests: 200, serverErrors: 40 }));
    expect(evaluations.find((e) => e.name === 'HighErrorRate')?.observed).toContain('20.00%');
  });
});

describe('diffAlerts', () => {
  const fire = (name: string, severity: 'critical' | 'warning' = 'warning') => ({
    name,
    severity,
    firing: true,
    observed: 'x',
  });
  const quiet = (name: string) => ({ name, severity: 'warning' as const, firing: false, observed: '' });

  it('reports only transitions (opened / cleared)', () => {
    const { opened, cleared } = diffAlerts(
      new Set(['A']),
      [fire('B'), quiet('A')],
    );
    expect(opened.map((e) => e.name)).toEqual(['B']);
    expect(cleared).toEqual(['A']);
  });

  it('does not re-report a steady firing condition', () => {
    const { opened, cleared } = diffAlerts(new Set(['A']), [fire('A')]);
    expect(opened).toEqual([]);
    expect(cleared).toEqual([]);
  });
});

describe('registerAlerting', () => {
  it('registers a handler and schedules a recurring job on the job context', async () => {
    const handlers = new Map<string, () => Promise<void>>();
    const schedules: Array<{ name: string; everyMs: number }> = [];
    const jobs = {
      handle: (name: string, handler: () => Promise<void>) => {
        handlers.set(name, handler);
      },
      schedule: async (name: string, options: { everyMs: number }) => {
        schedules.push({ name, everyMs: options.everyMs });
      },
    };

    await registerAlerting(jobs as never, {
      collector: { refresh: async () => undefined },
      intervalMs: 60_000,
    });

    expect(ALERT_JOB).toBe('observability.alerts');
    expect(handlers.has(ALERT_JOB)).toBe(true);
    expect(schedules).toEqual([{ name: ALERT_JOB, everyMs: 60_000 }]);
  });

  it('contains a collector failure and logs instead of throwing', async () => {
    const handlers = new Map<string, () => Promise<void>>();
    const jobs = {
      handle: (name: string, handler: () => Promise<void>) => {
        handlers.set(name, handler);
      },
      schedule: async () => undefined,
    };
    const warnings: string[] = [];

    await registerAlerting(jobs as never, {
      collector: {
        refresh: async () => {
          throw new Error('boom');
        },
      },
      logger: { warn: (message) => warnings.push(message) },
    });

    const handler = handlers.get(ALERT_JOB);
    expect(handler).toBeDefined();
    await expect(handler?.()).resolves.toBeUndefined();
    expect(warnings.some((message) => message.includes('评估失败'))).toBe(true);
  });
});

