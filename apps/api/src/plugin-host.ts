/**
 * Shared plugin host (S6).
 *
 * The API process and the standalone worker process must assemble the exact
 * same kernel services and plugin runtime, otherwise a plugin's `ctx.jobs.handle`
 * registered by the worker would use a different `ctx` than the API enqueued
 * from. This module is that single assembly: it builds the kernel services, the
 * {@link PluginRuntime}, seeds/scans plugins, and activates the enabled ones.
 *
 * The API additionally binds routes onto its HTTP dispatcher via the injected
 * `registerRoute`/`removeRoutes` callbacks; the worker leaves them unset (it has
 * no HTTP surface). Everything else is identical.
 */
import type { PaymentProvider, PaymentSettlementHandler, PluginRoute } from '@stackpanel/sdk';
import type { CaptchaProvider, IdentityChallengeSender } from '@stackpanel/sdk';
import type { NotificationChannel, NotificationTypeDefinition } from '@stackpanel/sdk';
import type { PrismaClient } from '@stackpanel/db';
import { peekRedis } from '@stackpanel/db';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import {
  ensurePluginModuleResolution,
  loadPluginDefinition,
  scanPlugins,
  seedBuiltinPlugins,
} from './lib/plugins.ts';
import { packageManager } from './packages/manager.ts';
import { MarketService } from './market/service.ts';
import { getCatalogRefresh } from './distribution/runtime.ts';
import { runAutoUpdate } from './updates/auto-run.ts';
import { env } from './config/env.ts';
import { configureRuntimeCoherence, type RuntimeCoherence } from './runtime/coherence.ts';
import { getEventBus, getOutboxBus } from './plugins/events.ts';
import { getPrisma } from './plugins/prisma.ts';
import { ExtensionService } from './extensions/service.ts';
import { PluginRuntime } from './plugins/runtime.ts';
import { refreshAllIsolatedServiceSnapshots } from './plugins/isolated/host.ts';
import { PaymentsService } from './payments/payments-service.ts';
import { ManualPaymentProvider } from './payments/manual-provider.ts';
import { WalletService } from './wallet/wallet-service.ts';
import { FxService } from './fx/fx-service.ts';
import { KernelCurrencyService } from './currency/service.ts';
import { KernelAuthService } from './auth/auth-service.ts';
import { KernelNotificationsService } from './notifications/notifications-service.ts';
import { KernelNotificationPolicyService } from './notifications/policy-service.ts';
import { KernelIdentityChallengeService } from './auth/identity-challenge-service.ts';
import { KernelCaptchaService } from './auth/captcha-service.ts';
import { createStorageWatch } from './notifications/storage-watch.ts';
import { listAdminUserIds } from './lib/admin-recipients.ts';
import { getStateService } from './state/index.ts';
import { getCacheService, getDataCache } from './cache/index.ts';
import { getJobRuntime, registerKernelSweeps, createKernelJobContext } from './jobs/index.ts';
import { registerBackupJobs } from './backup/jobs.ts';
import { registerConversationRetentionJobs } from './agent/retention.ts';
import { registerMediaJobs } from './media/jobs.ts';
import { AttachmentReferenceService } from './media/references.ts';
import { getStorage, setStorageRuntime, refreshStorageDriver } from './infra.ts';
import { NotificationDispatcher } from './notifications/dispatcher.ts';
import { loadRuntimeConfig } from './config/runtime-config.ts';

export interface PluginHostLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface PluginHostOptions {
  logger: PluginHostLogger;
  /** HTTP dispatcher binding (API only). Omitted in the worker. */
  registerRoute?: (
    pluginId: string,
    route: PluginRoute,
    isActive: () => boolean,
    openApi?: { capabilityId: string; mutating: boolean; scope?: string },
  ) => () => void;
  removeRoutes?: (pluginId: string) => void;
  /** Build the Extension engine (API wires its `/custom` routes). */
  extensions?: ExtensionService;
  /** Invoked when another replica broadcasts a theme change (API hook). */
  onThemeReload?: () => void | Promise<void>;
}

export interface PluginHost {
  runtime: PluginRuntime;
  /** 市场分发安全原语（内置插件 `market` 经 `kernel.market` 消费）。 */
  market: MarketService;
  payments: PaymentsService;
  wallet: WalletService;
  fx: FxService;
  currency: KernelCurrencyService;
  auth: KernelAuthService;
  notifications: KernelNotificationsService;
  notificationPolicy: KernelNotificationPolicyService;
  identity: KernelIdentityChallengeService;
  captcha: KernelCaptchaService;
  state: ReturnType<typeof getStateService>;
  cache: ReturnType<typeof getCacheService>;
  /** Extension engine instance (tables, clients, finalizers). */
  extensions: ExtensionService;
  /** Shared attachment reference index used by plugin contexts and media routes. */
  media: AttachmentReferenceService;
  /** Cross-replica runtime invalidation (S8). */
  coherence: RuntimeCoherence;
  /** Seed built-ins, scan installed packages and register their definitions. */
  registerPlugins(): Promise<void>;
  /** Activate plugins whose persisted `enabled` flag is true. */
  syncEnabledPlugins(): Promise<void>;
  /** Register the kernel's own recurring sweeps (state/payments/outbox). */
  registerKernelJobs(): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    pluginHost: PluginHost;
    /** Kernel-owned human-verification service (same instance plugins get as `ctx.captcha`). */
    captcha: KernelCaptchaService;
  }
}

/** Build the shared kernel services + plugin runtime. */
export function createPluginHost(options: PluginHostOptions): PluginHost {
  const logger = options.logger;
  // `runtime` is created after the payment service, but the payment service's
  // provider/settlement getters read live extensions from it. A holder breaks
  // the cycle without a `let` (which would be a single-assignment forward ref).
  const runtimeRef: { current?: PluginRuntime } = {};
  const getRuntime = (): PluginRuntime => {
    if (!runtimeRef.current) throw new Error('PluginRuntime 尚未初始化');
    return runtimeRef.current;
  };
  const walletService = new WalletService({ db: getPrisma() });
  const currencyService = new KernelCurrencyService({ db: getPrisma() });
  const fxService = new FxService({
    db: getPrisma(),
    getSettlementCurrency: () => currencyService.getSettlementCurrency(),
  });
  const authService = new KernelAuthService({ db: getPrisma() });
  // 两级通知偏好引擎：目录来自内核内建 + `notification.type` 扩展点，
  // 渠道来自 `notification.channel` 扩展点。需先于通知服务创建（后者读它做站内过滤）。
  const notificationPolicy = new KernelNotificationPolicyService({
    db: getPrisma(),
    getChannels: () =>
      getRuntime().getExtensions<NotificationChannel>(EXTENSION_POINTS.notificationChannel),
    getTypeDefinitions: () =>
      getRuntime().getExtensions<NotificationTypeDefinition>(EXTENSION_POINTS.notificationType),
    logger: { warn: (message) => logger.warn(message) },
  });
  const notificationsService = new KernelNotificationsService({
    db: getPrisma(),
    events: getEventBus(),
    policy: notificationPolicy,
  });
  const stateService = getStateService();
  const cacheService = getCacheService();
  const identityService = new KernelIdentityChallengeService({
    db: getPrisma(),
    state: stateService,
    getSenders: () =>
      getRuntime().getExtensions<IdentityChallengeSender>(EXTENSION_POINTS.identityChallengeSender),
    secret: env.JWT_SECRET,
    logger,
  });
  const captchaService = new KernelCaptchaService({
    getProviders: () =>
      getRuntime().getExtensions<CaptchaProvider>(EXTENSION_POINTS.captchaProvider),
    logger: { warn: (message) => logger.warn(message) },
  });
  const notificationDispatcher = new NotificationDispatcher({
    db: getPrisma(),
    events: getEventBus(),
    getChannels: () =>
      getRuntime().getExtensions<NotificationChannel>(EXTENSION_POINTS.notificationChannel),
    policy: notificationPolicy,
    logger: { warn: (message) => logger.warn(message) },
  });
  const paymentsService = new PaymentsService({
    db: getPrisma(),
    events: getEventBus(),
    wallet: walletService,
    getProviders: () => [
      new ManualPaymentProvider(),
      ...getRuntime().getExtensions<PaymentProvider>(EXTENSION_POINTS.paymentProvider),
    ],
    getSettlementHandlers: () =>
      getRuntime().getExtensions<PaymentSettlementHandler>(EXTENSION_POINTS.paymentSettlement),
    notifications: notificationsService,
    logger,
  });

  const extensions = options.extensions ?? new ExtensionService(getPrisma(), getDataCache());
  const media = new AttachmentReferenceService(getPrisma());
  // `market` is a kernel capability service consumed by the built-in `market`
  // plugin. It needs the plugin runtime (to register/activate after install),
  // but the runtime needs every capability service up front — forward lazily.
  const market = new MarketService({
    runtime: {
      has: (id) => getRuntime().has(id),
      isActive: (id) => getRuntime().isActive(id),
      register: (definition) => getRuntime().register(definition),
      unregister: (id, opts) => getRuntime().unregister(id, opts),
      activate: (id) => getRuntime().activate(id),
    },
  });
  const runtime = new PluginRuntime({
    events: getEventBus(),
    db: getPrisma(),
    extensions,
    payments: paymentsService,
    wallet: walletService,
    fx: fxService,
    currency: currencyService,
    auth: authService,
    notifications: notificationsService,
    notificationPolicy,
    identity: identityService,
    captcha: captchaService,
    state: stateService,
    cache: cacheService,
    jobs: getJobRuntime(),
    media,
    market,
    logger,
    registerRoute: options.registerRoute ?? (() => () => undefined),
    removeRoutes: options.removeRoutes ?? (() => undefined),
  });
  runtimeRef.current = runtime;

  // ADR-0014 扩展：把 storage.provider 的实际解析接到内核单例。绑定时立即解析一次，
  // 并在插件激活/停用后重新解析——激活事件在 onActivate 之后发布、停用事件在
  // effects.dispose()（撤销扩展注册）之后发布，因此此刻读扩展点必然反映最新状态。
  setStorageRuntime(runtime);
  getEventBus().subscribe('plugin.activated', () => refreshStorageDriver());
  getEventBus().subscribe('plugin.deactivated', () => refreshStorageDriver());

  // 通知渠道分发底座（审计 §5）：订阅站内通知事件，把通知 fan-out 到外部渠道，
  // 并写入持久投递记录。渠道由 `notification.channel` 扩展点供给。
  notificationDispatcher.start();

  // S8: cross-replica runtime coherence. Configured here (shared by API +
  // worker); the entrypoints explicitly `start()` the subscriber so hermetic
  // tests that call `buildApp` never open a Redis subscription.
  const coherence = configureRuntimeCoherence({
    runtime,
    redis: peekRedis(),
    loadDefinition: loadPluginDefinition,
    isEnabled: async (id) => {
      const row = await getPrisma().plugin.findUnique({ where: { id } });
      return row?.enabled ?? false;
    },
    onThemeReload: () => options.onThemeReload?.(),
    // ADR-0026: another replica changed a DB-backed config value; re-read the
    // snapshot so the next request on this replica uses it without a restart.
    onConfigReload: () => loadRuntimeConfig(),
    // The isolation frame carries a snapshot of the *synchronous* kernel service
    // values; a config change can invalidate it, so ask every live worker for a
    // refresh instead of waiting for the next activation.
    onServiceSnapshotStale: () => refreshAllIsolatedServiceSnapshots(),
    logger: { warn: (message) => logger.warn(message), info: (message) => logger.info(message) },
  });

  return {
    runtime,
    market,
    payments: paymentsService,
    wallet: walletService,
    fx: fxService,
    currency: currencyService,
    auth: authService,
    notifications: notificationsService,
    notificationPolicy,
    identity: identityService,
    captcha: captchaService,
    state: stateService,
    cache: cacheService,
    extensions,
    media,
    coherence,
    async registerPlugins(): Promise<void> {
      await ensurePluginModuleResolution((message) => console.info(message));
      await seedBuiltinPlugins();
      // 回收上次崩溃遗留的未引用暂存/备份产物（§7.6/§7.8）；活动目录不受影响。
      await packageManager.gcAll().catch(() => undefined);
      await authService.seedPlatformPermissions();
      const definitions = await scanPlugins();
      for (const definition of definitions) {
        try {
          await runtime.register(definition);
          if (!definition.manifest.builtin) {
            await getPrisma().plugin.upsert({
              where: { id: definition.manifest.id },
              create: {
                id: definition.manifest.id,
                name: definition.manifest.name,
                version: definition.manifest.version,
                enabled: false,
              },
              update: {
                name: definition.manifest.name,
                version: definition.manifest.version,
              },
            });
          }
        } catch (err) {
          logger.error(String(err));
        }
      }
    },
    async syncEnabledPlugins(): Promise<void> {
      const prisma: PrismaClient = getPrisma();
      const rows = await prisma.plugin.findMany({ where: { enabled: true } });
      for (const row of rows) {
        if (!runtime.has(row.id)) continue;
        await runtime.activate(row.id);
      }
    },
    registerKernelJobs(): void {
      const kernelJobs = createKernelJobContext('kernel', getJobRuntime());
      const catalogRefresh = getCatalogRefresh();
      void registerKernelSweeps(kernelJobs, {
        stateSweep: () => stateService.sweep(),
        paymentSweep: () => paymentsService.sweepExpired().then(() => undefined),
        walletHoldSweep: () => walletService.sweepExpiredHolds().then(() => undefined),
        outboxRelay: () => getOutboxBus().relay(),
        outboxCleanup: () =>
          getOutboxBus()
            .cleanup()
            .then(() => undefined),
        notificationDeliverySweep: () => notificationDispatcher.sweep(),
        // 存储巡检（对标 #12.5 `ossExceptionNotice`）：连续失败才告警管理员，
        // 连续成功才报恢复。探测本身失败只累加计数，不抛给任务。
        storageWatch: createStorageWatch({
          ping: async () => {
            const driver = getStorage();
            if (!('ping' in driver) || typeof (driver as { ping?: unknown }).ping !== 'function') {
              // 本地磁盘驱动没有探测能力：磁盘挂了 API 自己也起不来，无需巡检。
              return true;
            }
            return (driver as unknown as { ping(): Promise<boolean> }).ping();
          },
          notifications: notificationsService,
          listAdminIds: () => listAdminUserIds(getPrisma()),
          logger,
        }),
        // 会员权益到期清理：删除已过期的限时成员关系（会员商品授予）。
        // 授权正确性由读路径保证，这里只是数据清理。
        membershipSweep: async () => {
          const removed = await authService.pruneExpiredUserGroups();
          if (removed.length > 0) {
            logger.info(`[membership] 清理 ${removed.length} 条过期会员权益`);
          }
        },
        // §10：后台目录刷新。目录源被显式关闭时为 undefined（不注册、零出网）；
        // 默认源开启时注册，失败会在下方记日志并通过市场/更新中心的状态暴露。
        ...(catalogRefresh
          ? {
              catalogRefresh: async () => {
                const result = await catalogRefresh.refresh();
                if (result.failure) {
                  logger.warn(
                    `[distribution] 目录刷新失败（${result.failure.kind}）：${result.failure.message}`,
                  );
                }
              },
              // §13-6：刷新后按策略评估自动更新。默认策略关闭，只有显式开启才投递。
              autoUpdate: async () => {
                const result = await runAutoUpdate({ prisma: getPrisma() });
                if (result.submitted) {
                  logger.info(
                    `[distribution] 自动更新已投递（${result.idempotencyKey ?? ''}）：${result.reason}`,
                  );
                } else if (result.reason !== 'auto-disabled') {
                  logger.info(
                    `[distribution] 自动更新跳过：${result.reason} ${result.detail ?? ''}`,
                  );
                }
              },
            }
          : {}),
        logger: { warn: (message) => logger.warn(message) },
      });
      // ADR-0018: export/import run on any consumer (API replicas and worker),
      // not worker-only, so a queued backup never waits on a bounded retry to
      // reach a process that holds the handler.
      registerBackupJobs(kernelJobs);
      // MEDIA-ASYNC（ADR-0014 §4 阶段 B）：变体编码任务 + 回填清扫（API 与 worker 共同注册点）。
      registerMediaJobs(kernelJobs);
      registerConversationRetentionJobs(kernelJobs);
    },
  };
}
