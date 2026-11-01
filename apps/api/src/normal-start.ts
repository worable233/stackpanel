/**
 * 正常启动路径（自举完成后）。
 *
 * 本文件是原来的 `server.ts` 主体：初始化基础设施、构建完整 app、注册插件、
 * 启动监听与优雅退出。它只在**不处于 provision 模式**时被动态 import，
 * 因此 provision 模式不会加载 Prisma / Redis / 插件宿主。
 *
 * 迁移由 runner 执行，本入口不做 `migrate deploy`（ADR-0025）。
 */

import path from 'node:path';
import { buildApp, describeTrustProxy } from './app.ts';
import { loadCatalogSourceConfig } from './distribution/source-config.ts';
import { readReleaseInfo } from './bootstrap/release-version.ts';
import { seedDefaultKeyring } from './distribution/default-keyring.ts';
import { KEYRING_FILE, loadKeyring } from './distribution/keyring.ts';
import { setBootReport, type TrustSummary } from './lib/boot-report.ts';
import { describeMemory } from './lib/memory-report.ts';
import { getConfig } from './config/runtime-config.ts';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { KERNEL_API_VERSION, KERNEL_VERSION } from '@stackpanel/spec';
import { env } from './config/env.ts';
import { setupStatus } from './auth/install-claim.ts';
import { initInfra } from './infra.ts';
import { startOutboxConsumption } from './plugins/events.ts';
import { startRuntimeCoherence, stopRuntimeCoherence } from './runtime/coherence.ts';
import { loadRuntimeConfig } from './config/runtime-config.ts';
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

// 分发源配置可能由后台保存（数据库覆盖环境变量）。`buildApp()` 是同步的且会在
// 注册内核任务时读取配置，所以先预热一次，避免首次启动用错源。
await loadCatalogSourceConfig();

// 运行期配置（ADR-0026）同样是「数据库覆盖环境变量」，且 `buildApp()` 注册路由时
// 就会读（会话 TTL、上传上限、限流额度……）。先预热快照，避免首个请求用到 .env 旧值。
await loadRuntimeConfig();

// 信任根**随内核安装**（packages/spec trust.ts 的契约）。全新实例的数据目录里没有
// `trust/keyring.json` 时市场里一个包都装不上，而界面只说「安装失败」——v0.1.0/
// v0.1.1 的默认 compose 部署就是这么坏掉的。这里在首启时幂等写入默认公钥（已存在
// 则原样保留，解析失败也不覆盖）。
await seedDefaultKeyring();

const keyring = await loadKeyring();
const signatureRequired = getConfig('PACKAGE_SIGNATURE_REQUIRED') === true;
const trust: TrustSummary = {
  catalogKeys: keyring.keys.filter((key) => key.purpose === 'catalog' && !key.revoked).length,
  packageKeys: keyring.keys.filter((key) => key.purpose === 'package' && !key.revoked).length,
  kernelKeys: keyring.keys.filter((key) => key.purpose === 'kernel' && !key.revoked).length,
  signatureRequired,
  keyringPath: path.join(resolveStackPanelDataDir(), KEYRING_FILE),
};
if (signatureRequired && trust.packageKeys === 0) {
  // 以前只有 env 解析期的一行 warn，而且发生在「上传已经被拒」之后。信任根缺失是
  // 部署配置问题，必须在启动日志里说清「缺什么、在哪、怎么补」。
  console.error(
    `[trust] PACKAGE_SIGNATURE_REQUIRED=true，但信任根里没有可用的 package 公钥：` +
      `${trust.keyringPath}。上传插件/主题会被拒绝——请在该文件补一把 package 公钥，` +
      '或删除该文件后重启以生成默认信任根，或在后台关闭签名校验。',
  );
}

const release = readReleaseInfo(import.meta.url);
// 镜像里没有 `RELEASE.json`（只有自包含产物带），但版本号编译期就在 `KERNEL_VERSION`。
// 两边都不看就得到 `unknown`——那正是线上排障最不想看到的答案。
const reportedVersion = release.version === 'unknown' ? KERNEL_VERSION : release.version;
setBootReport({
  version: reportedVersion,
  apiVersion: KERNEL_API_VERSION,
  commit: release.commit,
  builtAt: release.builtAt,
  startedAt: new Date().toISOString(),
  trustProxy: describeTrustProxy(),
  trust,
});

const app = buildApp({ redis: peekRedis() });
app.log.info(
  `[api] stackpanel ${reportedVersion}` +
    (release.commit ? ` (commit ${release.commit.slice(0, 8)})` : '') +
    ` · API_TRUST_PROXY=${describeTrustProxy()} · 信任根：catalog ${trust.catalogKeys}/package ${trust.packageKeys}/kernel ${trust.kernelKeys}`,
);
// 堆上限要显式可见：没设 `--max-old-space-size` 时 V8 只给容器限额的一半左右，
// 这是 v0.1.1 装到 10+ 插件后 OOM 的直接原因。看到这个数字才知道该调多大。
app.log.info(`[api] 内存：${describeMemory()}`);

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
