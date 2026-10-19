/**
 * 正常启动路径（自举完成后）。
 *
 * 本文件是原来的 `server.ts` 主体：初始化基础设施、构建完整 app、注册插件、
 * 启动监听与优雅退出。它只在**不处于 provision 模式**时被动态 import，
 * 因此 provision 模式不会加载 Prisma / Redis / 插件宿主。
 *
 * 迁移由 runner 执行，本入口不做 `migrate deploy`（ADR-0025）。
 */

import { buildApp } from './app.ts';
import { env } from './config/env.ts';
import { setupStatus } from './auth/install-claim.ts';
import { initInfra } from './infra.ts';
import { startOutboxConsumption } from './plugins/events.ts';
import { startRuntimeCoherence, stopRuntimeCoherence } from './runtime/coherence.ts';
import { startTracing, stopTracing } from './observability/index.ts';
import { peekRedis } from '@stackpanel/db';
import { stopAllIsolatedPlugins } from './plugins/isolated/host.ts';

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
    // First-run guidance: no admin is auto-created. A fresh instance is claimed
    // from the browser at `/setup` (or by an installed plugin/seed that
    // provisions an admin out-of-band). We only announce the state; the wizard
    // itself is authoritative and self-disables once an admin exists.
    const setup = await setupStatus();
    if (setup.required) {
      app.log.warn(
        '[setup] 实例尚未初始化：请打开 Web 站点按引导创建首个管理员（/setup）。' +
          (setup.tokenRequired ? ' 本次认领需要 .env 中的 STACKPANEL_SETUP_TOKEN。' : ''),
      );
    }
    // Ready first so onReady hooks register discovered plugins and seed themes
    // before we apply persisted plugin enable states.
    await app.ready();
    await app.pluginHost.syncEnabledPlugins();
    // W3 (audit 4B · B-1): begin per-replica durable catch-up only *after* the
    // plugins above have subscribed. Starting it in initInfra() would advance
    // this replica's cursor with zero local listeners and lose a restarting
    // replica's missed events.
    startOutboxConsumption();
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
    stopAllIsolatedPlugins();
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

export default async function run(): Promise<void> {
  void start();

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
