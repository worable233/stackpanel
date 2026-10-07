/**
 * Standalone worker process (S6 / ADR-0013, PLAN §4).
 *
 * Runs the background half of the kernel: it attaches the job backend, loads
 * and activates the same plugins as the API (via the shared {@link
 * createPluginHost}), and consumes the BullMQ queue. It serves no HTTP.
 *
 * Why a separate process: task/queue load and (later) frontend builds must not
 * compete with request handling, and API replicas can roll independently of the
 * worker. BullMQ guarantees each job is fetched by exactly one worker, so
 * running this alongside N API replicas (which also consume) stays correct.
 *
 * Plugin handlers are registered here through the same `PluginContext` the API
 * uses, because both processes are built by `createPluginHost`. A job whose
 * handler is not registered on the replica that receives it fails fast and is
 * retried on another replica.
 */
import { createPluginHost } from './plugin-host.ts';
import { initInfra } from './infra.ts';
import { getJobRuntime } from './jobs/index.ts';
import { startRuntimeCoherence, stopRuntimeCoherence } from './runtime/coherence.ts';
import { FrontendBuilder } from './lib/frontend-build.ts';
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

  const host = createPluginHost({ logger });
  // Kernel sweeps are shared by every replica that consumes; register them here
  // too so a sweep job routed to this worker is handled instead of retried.
  host.registerKernelJobs();
  await host.registerPlugins();
  await host.syncEnabledPlugins();

  // S8: keep plugin runtime state coherent when an API replica (or another
  // worker) activates/deactivates/reloads a plugin. The worker consumes jobs,
  // so it must not serve stale plugin handlers.
  await startRuntimeCoherence();

  // S7: the worker is the single frontend builder. Each web replica only picks
  // up the new artifact signature and restarts itself.
  builder = new FrontendBuilder({ redis: peekRedis(), logger });
  builder.start();

  logger.info('[worker] 已就绪，等待任务');
}

let builder: FrontendBuilder | null = null;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[worker] 收到 ${signal}，正在停止`);
  try {
    stopAllIsolatedPlugins();
    await builder?.stop();
    await stopRuntimeCoherence();
    await getJobRuntime().stop();
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
