/**
 * HTTP metrics instrumentation (ADR-0015 §2).
 *
 * Wires Fastify lifecycle hooks into the {@link Metrics} registry:
 *   - in-flight gauge (`onRequest` / `onResponse`)
 *   - request counter + latency histogram (`onResponse`)
 *   - rate-limit rejections, derived from the final `429` status
 *
 * Cardinality is deliberately bounded: the `route` label is the registered
 * route template, never the raw URL. Kernel routes expose theirs through
 * `request.routeOptions.url`; plugin routes are served by the dispatcher's
 * catch-all, so the dispatcher's matched pattern is used instead. Anything that
 * still cannot be resolved collapses to `unmatched`.
 *
 * Rejections are counted in `onResponse` rather than `@fastify/rate-limit`'s
 * `onExceeded` hook on purpose: that hook reads its callback from the route
 * config during `onRoute`, so a later-added `onRoute` hook cannot override it
 * deterministically. The final status is the one signal that is always visible.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Metrics } from './metrics.ts';

/** The scrape endpoint is excluded so monitoring does not distort its own signal. */
const SCRAPE_PATH = '/metrics';

/** Resolve a bounded route-template label for a request. */
function routeTemplate(app: FastifyInstance, request: FastifyRequest): string {
  const registered = request.routeOptions?.url;
  if (typeof registered === 'string' && registered.length > 0 && registered !== '/*') {
    return registered;
  }
  // Plugin routes: recover the plugin's declared pattern from the dispatcher so
  // `/store/products/:id` does not collapse into the `/*` catch-all bucket.
  const pathname = request.url.split('?')[0] ?? request.url;
  const matched = app.pluginDispatcher?.match(request.method, pathname);
  if (matched) return matched.route.path;
  return registered && registered.length > 0 ? registered : 'unmatched';
}

/** Status-class label (`2xx`, `4xx`, ...) keeps the histogram low-cardinality. */
function statusClass(code: number): string {
  return `${Math.floor(code / 100)}xx`;
}

/** Classify a 429 as an open-platform token quota or a route limiter. */
function rejectionScope(request: FastifyRequest): 'http' | 'open_api_token' {
  return request.user?.viaApiToken ? 'open_api_token' : 'http';
}

/**
 * Install metrics hooks on an app instance. The `onResponse` hook is the single
 * accounting point so every exit path (success, error, not-found, rate-limit)
 * is counted exactly once.
 */
export function installHttpMetrics(app: FastifyInstance, metrics: Metrics): void {
  app.addHook('onRequest', async (request) => {
    metrics.httpRequestsInFlight.inc({ method: request.method });
  });

  app.addHook('onResponse', async (request, reply) => {
    const method = request.method;
    metrics.httpRequestsInFlight.dec({ method });

    const pathname = request.url.split('?')[0] ?? request.url;
    if (pathname === SCRAPE_PATH) return;

    const labels = {
      method,
      route: routeTemplate(app, request),
      status: statusClass(reply.statusCode),
    };
    metrics.httpRequestsTotal.inc(labels);
    metrics.httpRequestDurationSeconds.observe(labels, reply.elapsedTime / 1000);

    if (reply.statusCode === 429) {
      metrics.rateLimitRejectionsTotal.inc({ scope: rejectionScope(request) });
    }
  });
}
