import { buildApp } from './app.ts';
import { env } from './config/env.ts';
import { ensureBootstrapAdmin } from './lib/bootstrap.ts';
import { initInfra } from './infra.ts';
import { startRuntimeCoherence, stopRuntimeCoherence } from './runtime/coherence.ts';
import { startTracing, stopTracing } from './observability/index.ts';
import { peekRedis } from '@stackpanel/db';

/**
 * Start tracing before anything else so HTTP instrumentation is installed
 * before Fastify attaches its listener (ADR-0015 §1). No-op unless configured.
 */
startTracing();

/**
 * Connect infrastructure before building the app: the rate limiter needs the
 * shared Redis client at registration time (ADR-0017 §2), and a production
 * misconfiguration must fail fast with a clear message.
 */
try {
  await initInfra();
} catch (err) {
  console.error('[server] 基础设施初始化失败：', err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = buildApp({ redis: peekRedis() });

async function start(): Promise<void> {
  try {
    const bootstrap = await ensureBootstrapAdmin();
    if (bootstrap.created) {
      app.log.info(`Bootstrap admin created: ${bootstrap.email}`);
      if (bootstrap.generatedPassword) {
        app.log.warn(`Bootstrap password (shown once): ${bootstrap.generatedPassword}`);
      }
    }
    // Ready first so onReady hooks register discovered plugins and seed themes
    // before we apply persisted plugin enable states.
    await app.ready();
    await app.pluginHost.syncEnabledPlugins();
    // S8: subscribe to cross-replica runtime invalidation once the runtime has
    // registered all installed plugins (after ready/plugin discovery).
    await startRuntimeCoherence();
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

/** How long to wait for in-flight raw streams before forcing the process down. */
const DRAIN_GRACE_MS = 30_000;

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    // Stop accepting new connections; let long-lived raw streams (SSE / upstream
    // proxies) finish within a grace window, then force-close the rest.
    const grace = new Promise<void>((resolve) => setTimeout(resolve, DRAIN_GRACE_MS));
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await Promise.race([closing, grace]);
    if (!closed) {
      const remaining = app.pluginDispatcher.inFlightRaw;
      app.log.warn(
        `Shutdown: forcing exit after ${DRAIN_GRACE_MS}ms (${remaining} raw stream(s) in flight)`,
      );
      app.server.closeAllConnections();
      await closing.catch(() => undefined);
    }
  } catch (err) {
    app.log.error(err);
  } finally {
    await stopRuntimeCoherence().catch(() => undefined);
    await stopTracing().catch(() => undefined);
    process.exit(0);
  }
}

void start();

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
