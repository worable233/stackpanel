import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.ts';
import { metricsContentType, renderMetrics } from '../observability/metrics.ts';
import { getMetricsCollector } from '../observability/index.ts';

/** Constant-time comparison of two secrets of possibly different lengths. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

/** Loopback-only by default so an unauthenticated cluster keeps metrics internal. */
function isLoopback(request: FastifyRequest): boolean {
  const ip = request.ip;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Prometheus scrape endpoint (ADR-0015 §2).
 *
 * Access control is layered:
 *   - when `METRICS_TOKEN` is set, a matching `Authorization: Bearer <token>`
 *     is required (the recommended mode behind an internal scraper);
 *   - otherwise the endpoint answers only loopback callers and reports 404 to
 *     everyone else, so it is neither exposed nor fingerprintable from outside.
 *
 * The response is the Prometheus text exposition format, never JSON, and is
 * excluded from the problem+json normaliser because it is not an error.
 */
export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  if (!env.METRICS_ENABLED) return;

  app.get('/metrics', async (request, reply) => {
    const token = env.METRICS_TOKEN;
    if (token) {
      const presented = bearer(request);
      if (!presented || !safeEqual(presented, token)) {
        return reply.code(401).send({
          status: 401,
          code: 'request.unauthorized',
          detail: '未授权的指标访问',
          instance: request.url,
          requestId: request.id,
        });
      }
    } else if (!isLoopback(request)) {
      // Hide the endpoint entirely from non-loopback callers.
      return reply.code(404).send({
        status: 404,
        code: 'request.not_found',
        detail: '接口不存在',
        instance: request.url,
        requestId: request.id,
      });
    }

    // Refresh pull gauges before rendering so a scrape reflects queue depth and
    // outbox backlog. Tolerant: collection failures leave the scrape intact.
    await getMetricsCollector().refresh();

    reply.header('content-type', metricsContentType());
    return renderMetrics();
  });
}
