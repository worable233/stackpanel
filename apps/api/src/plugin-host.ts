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
import type { PrismaClient } from '@stackpanel/db';
import { peekRedis } from '@stackpanel/db';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import { loadPluginDefinition, scanPlugins, seedBuiltinPlugins } from './lib/plugins.ts';
import { packageManager } from './packages/manager.ts';
import { env } from './config/env.ts';
import { configureRuntimeCoherence, type RuntimeCoherence } from './runtime/coherence.ts';
import { getEventBus, getOutboxBus } from './plugins/events.ts';
import { getPrisma } from './plugins/prisma.ts';
import { ExtensionService } from './extensions/service.ts';
import { PluginRuntime } from './plugins/runtime.ts';
import { PaymentsService } from './payments/payments-service.ts';
import { ManualPaymentProvider } from './payments/manual-provider.ts';
import { WalletService } from './wallet/wallet-service.ts';
import { FxService } from './fx/fx-service.ts';
import { KernelAuthService } from './auth/auth-service.ts';
import { KernelNotificationsService } from './notifications/notifications-service.ts';
import { KernelIdentityChallengeService } from './auth/identity-challenge-service.ts';
import { KernelCaptchaService } from './auth/captcha-service.ts';
import { getStateService } from './state/index.ts';
import { getCacheService, getDataCache } from './cache/index.ts';
import { getJobRuntime, registerKernelSweeps, createKernelJobContext } from './jobs/index.ts';
import { registerBackupJobs } from './backup/jobs.ts';
import { registerMediaJobs } from './media/jobs.ts';
import { AttachmentReferenceService } from './media/references.ts';
import { setStorageRuntime, refreshStorageDriver } from './infra.ts';

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
  payments: PaymentsService;
  wallet: WalletService;
  fx: FxService;
  auth: KernelAuthService;
  notifications: KernelNotificationsService;
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
  const fxService = new FxService({ db: getPrisma() });
  const authService = new KernelAuthService({ db: getPrisma() });
  const notificationsService = new KernelNotificationsService({
    db: getPrisma(),
    events: getEventBus(),
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
    logger,
  });

  const extensions = options.extensions ?? new ExtensionService(getPrisma(), getDataCache());
  const media = new AttachmentReferenceService(getPrisma());
  const runtime = new PluginRuntime({
    events: getEventBus(),
    db: getPrisma(),
    extensions,
    payments: paymentsService,
    wallet: walletService,
    fx: fxService,
    auth: authService,
    notifications: notificationsService,
    identity: identityService,
    captcha: captchaService,
    state: stateService,
    cache: cacheService,
    jobs: getJobRuntime(),
    media,
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
    logger: { warn: (message) => logger.warn(message), info: (message) => logger.info(message) },
  });

  return {
    runtime,
    payments: paymentsService,
    wallet: walletService,
    fx: fxService,
    auth: authService,
    notifications: notificationsService,
    identity: identityService,
    captcha: captchaService,
    state: stateService,
    cache: cacheService,
    extensions,
    media,
    coherence,
    async registerPlugins(): Promise<void> {
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
      void registerKernelSweeps(kernelJobs, {
        stateSweep: () => stateService.sweep(),
        paymentSweep: () => paymentsService.sweepExpired().then(() => undefined),
        walletHoldSweep: () => walletService.sweepExpiredHolds().then(() => undefined),
        outboxRelay: () => getOutboxBus().relay(),
        outboxCleanup: () => getOutboxBus().cleanup().then(() => undefined),
        logger: { warn: (message) => logger.warn(message) },
      });
      // ADR-0018: export/import run on any consumer (API replicas and worker),
      // not worker-only, so a queued backup never waits on a bounded retry to
      // reach a process that holds the handler.
      registerBackupJobs(kernelJobs);
      // MEDIA-ASYNC（ADR-0014 §4 阶段 B）：变体编码任务 + 回填清扫（API 与 worker 共同注册点）。
      registerMediaJobs(kernelJobs);
    },
  };
}
