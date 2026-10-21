/**
 * Standalone worker process (S6 / ADR-0013, PLAN §4).
 *
 * Runs the background half of the kernel: it attaches the job backend, loads
 * and activates the same plugins as the API (via the shared {@link
 * createPluginHost}), and consumes the BullMQ queue. It serves no HTTP.
 *
 * Why a separate process: task/queue load must not compete with request
 * handling, and API replicas can roll independently of the worker. BullMQ
 * guarantees each job is fetched by exactly one worker, so running this
 * alongside N API replicas (which also consume) stays correct.
 *
 * Plugin handlers are registered here through the same `PluginContext` the API
 * uses, because both processes are built by `createPluginHost`. A job whose
 * handler is not registered on the replica that receives it fails fast and is
 * retried on another replica.
 */
import { buildApp } from './app.ts';
import { loadCatalogSourceConfig } from './distribution/source-config.ts';
import type { FastifyInstance } from 'fastify';
import { initInfra } from './infra.ts';
import { startOutboxConsumption } from './plugins/events.ts';
import { getJobRuntime } from './jobs/index.ts';
import { startRuntimeCoherence, stopRuntimeCoherence } from './runtime/coherence.ts';
import { startTracing, stopTracing } from './observability/index.ts';
import { peekRedis } from '@stackpanel/db';
import { stopAllIsolatedPlugins } from './plugins/isolated/host.ts';

const logger = {
  info: (message: string) => console.info(message),
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
};

// Trace context for background work (ADR-0015 §1). No-op unless configured.
startTracing({ serviceName: 'stackpanel-worker' });

async function main(): Promise<void> {
  // Connect Redis (required in production) + object storage, bind the outbox
  // and start the job backend/worker.
  await initInfra();
  // 与 API 一致：先读生效的分发源配置（后台可覆盖环境变量）。
  await loadCatalogSourceConfig();

  // Build the same guarded HTTP stack without listening on a socket. Agent jobs
  // dispatch with the original credential through inject(), including on a dedicated worker.
  workerApp = buildApp({redis:peekRedis()});
  await workerApp.ready();
  await workerApp.pluginHost.syncEnabledPlugins();
  // W3 (audit 4B · B-1): durable consumption only after plugins subscribed.
  startOutboxConsumption();

  // S8: keep plugin runtime state coherent when an API replica (or another
  // worker) activates/deactivates/reloads a plugin. The worker consumes jobs,
  // so it must not serve stale plugin handlers.
  await startRuntimeCoherence();

  logger.info('[worker] 已就绪，等待任务');
}

let workerApp: FastifyInstance | null = null;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[worker] 收到 ${signal}，正在停止`);
  try {
    stopAllIsolatedPlugins();
    await stopRuntimeCoherence();
    await getJobRuntime().stop();
    await workerApp?.close();
    await stopTracing().catch(() => undefined);
  } catch (err) {
    logger.error(`[worker] 停止失败：${String(err)}`);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void main().catch((err) => {
  logger.error(`[worker] 启动失败：${String(err)}`);
  process.exit(1);
});
