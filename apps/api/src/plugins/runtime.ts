import type {
  AuthService,
  CacheService,
  CaptchaService,
  CurrencyService,
  EventBus,
  FxService,
  IdentityChallengeService,
  NotificationPolicyService,
  NotificationsService,
  PaymentService,
  StateService,
  PluginDependency,
  PluginExtensionConsumer,
  PluginContext,
  PluginDefinition,
  PluginLogger,
  PluginRoleTemplate,
  PluginRoute,
  WalletService,
} from '@stackpanel/sdk';
import {
  CurrencyError,
  DisposableList,
  findCurrency,
  formatMinorCurrency,
  listCurrencies,
  normalizePluginDependencies,
  normalizePluginPermissions,
  runEffect,
  toMinorUnits,
} from '@stackpanel/sdk';
import type { ExtensionTransaction } from '@stackpanel/sdk';
import { ExtensionValidationError } from '@stackpanel/sdk';
import { AsyncLocalStorage } from 'node:async_hooks';
import semver from 'semver';
import type { PrismaClient } from '@stackpanel/db';
import { pluginSecrets } from '../lib/crypto.ts';
import type { KernelAuth } from '../auth/auth-service.ts';
import { createKernelJobContext } from '../jobs/kernel-jobs.ts';
import type { JobRuntime } from '../jobs/types.ts';
import type { PluginExtensionRuntime } from '../extensions/service.ts';
import type { RawDatabase } from '../extensions/client.ts';
import type { MediaReferenceService } from '@stackpanel/sdk';
import type { MarketService } from '../market/service.ts';
import type { StorageService } from '@stackpanel/sdk';
import { createStorageService } from '../storage/backend.ts';
import { getCacheService } from '../cache/index.ts';
import {
  aggregateScopeGovernance,
  type Capability,
  type PluginCapabilityEntry,
  type ScopeGovernance,
} from '../lib/capability-registry.ts';
import {
  restartIsolatedPlugin,
  setIsolatedWorkerExitHandler,
  stopIsolatedPlugin,
} from './isolated/host.ts';
import { OutboxEventBus, outboxOrigin, serializeOutboxBody } from './events.ts';

/** Tracks an in-flight `ctx.tx` so nested calls fail with a clear error. */
const txContext = new AsyncLocalStorage<true>();
const ISOLATED_WORKER_FAILURE_THRESHOLD = 3;

/** True when the bound event bus is the durable outbox bus (kernel default). */
function isOutboxBus(events: EventBus): events is OutboxEventBus {
  return events instanceof OutboxEventBus;
}

/**
 * Fallback catalog for lifecycle-only runtimes (unit tests, hermetic boots).
 * It serves the static SDK catalog but cannot persist enable/disable toggles —
 * the real host always injects the DB-backed `KernelCurrencyService`.
 */
const STATIC_CURRENCY_SERVICE: CurrencyService = {
  list: async () => listCurrencies(),
  listEnabled: async () => listCurrencies().filter((definition) => definition.enabled),
  get: async (code) => findCurrency(code),
  requireEnabled: async (code) => {
    const definition = findCurrency(code);
    if (!definition) throw new CurrencyError('currency.invalid', 400, `不支持的币种：${code}`);
    if (!definition.enabled) {
      throw new CurrencyError('currency.disabled', 409, `币种 ${definition.code} 已被停用`);
    }
    return definition;
  },
  toMinor: (value, code) => toMinorUnits(value, code),
  format: (amountMinor, code, locale) => formatMinorCurrency(amountMinor, code, locale),
};

export interface PluginRuntimeOptions {
  events: EventBus;
  logger: PluginLogger;
  /** Kernel adapter that registers a plugin route onto the HTTP dispatcher and returns a disposer. */
  registerRoute: (
    pluginId: string,
    route: PluginRoute,
    isActive: () => boolean,
    openApi?: { capabilityId: string; mutating: boolean; scope?: string },
  ) => () => void;
  /** Remove every dispatched route contributed by a plugin id. */
  removeRoutes: (pluginId: string) => void;
  /**
   * Kernel database client used internally (permission seeding and `ctx.tx`
   * transactions). Never exposed to plugins: `PluginContext` has no `db` slot
   * (ADR-0008 §1).
   */
  db: unknown;
  /** Kernel-owned payment orchestration exposed to plugins via ctx.payments. */
  payments: PaymentService;
  /** Kernel-owned wallet service exposed to plugins via ctx.wallet. */
  wallet: WalletService;
  /** Kernel-owned FX service exposed to plugins via ctx.fx. */
  fx: FxService;
  /** Kernel-owned currency catalog + precision via ctx.currency. Optional so
   * lifecycle-only unit tests can construct a runtime without the full host;
   * the process-wide host always supplies the DB-backed implementation. */
  currency?: CurrencyService;
  /** Kernel-owned auth capabilities exposed to plugins via ctx.auth. */
  auth: AuthService;
  /** Kernel-owned notification service exposed to plugins via ctx.notifications. */
  notifications: NotificationsService;
  /** Kernel-owned two-level notification preference engine exposed via ctx.notificationPolicy. Optional (see `identity`). */
  notificationPolicy?: NotificationPolicyService;
  /**
   * Kernel-owned identity-challenge service exposed via ctx.identity. Optional
   * so lifecycle-only unit tests can construct a runtime without the host; the
   * process-wide host always supplies it.
   */
  identity?: IdentityChallengeService;
  /** Kernel-owned human-verification service exposed via ctx.captcha. Optional (see `identity`). */
  captcha?: CaptchaService;
  /** Kernel-owned shared state (counters, TTL keys, locks) via ctx.state. */
  state: StateService;
  /**
   * Kernel-owned bounded read cache for read-mostly configuration data
   * (ADR-0022 D3). Plugins declare which custom-model kinds a value derives
   * from; the kernel invalidates every replica when those kinds are written.
   *
   * Optional so unit tests can construct a runtime without the whole host; the
   * process-wide {@link getCacheService} singleton is used when omitted, which
   * keeps `ctx.cache` non-null for every plugin.
   */
  cache?: CacheService;
  /** Kernel-owned background jobs (enqueue/schedule/handle) via ctx.jobs. */
  jobs: JobRuntime;
  /** Extension engine: owns plugin model tables, clients and finalizers. */
  extensions: PluginExtensionRuntime;
  /** Kernel-owned attachment reference index. */
  media?: MediaReferenceService;
  /**
  /**
   * 市场分发安全原语（ADR-0020 D3）。市场业务面在内置插件 `market`；内核保留
   * 验签目录 / 统一安装事务 / 运行时激活，并以 `kernel.market` 暴露。
   *
   * Optional so unit tests can build a bare runtime; production always supplies it.
   */
  market?: MarketService;
  /**
   * Kernel-owned storage capability (`ctx.storage`, ADR-0014 extension):
   * builds a `StorageProvider` for a generic backend while keeping all
   * byte/presign machinery on the kernel side. Defaults to the standard factory.
   */
  storage?: StorageService;
}

/**
 * Kernel capability services offered to plugins as discoverable, non-hijackable
 * entries in the shared service registry (ADR-0021 §D3, minimal form). A plugin
 * resolves e.g. `ctx.getService('kernel.payments')`; the kernel registers these
 * before any plugin, so `provideService` rejects a plugin trying to squat the
 * name. The convenient `ctx.payments` / `ctx.wallet` / … accessors keep their
 * exact signatures — only the source became uniform.
 *
 * `ctx.jobs` and `ctx.media` are intentionally excluded: their kernel wrappers
 * inject per-plugin namespacing (job owner, attachment owner), which a shared
 * raw handle would bypass.
 */
const KERNEL_SERVICE_ACCESSORS = [
  'payments',
  'wallet',
  'fx',
  'auth',
  'notifications',
  'notificationPolicy',
  'identity',
  'captcha',
  'state',
  'cache',
  /**
   * 市场分发安全原语（ADR-0020 D3）。市场业务面在内置插件 `market`，内核只
   * 保留验签目录 / 安装事务 / 运行时激活，并以 `kernel.market` 暴露给插件消费。
   */
  'market',
] as const;

const KERNEL_SERVICE_OWNER = 'kernel';

/**
 * Fail-safe stand-ins for the identity/captcha kernel services when a runtime
 * is constructed without the full host (lifecycle unit tests). They deny rather
 * than silently pass: an unavailable captcha is "not configured" and issuing a
 * code throws. The real host always supplies the concrete services.
 */
const UNAVAILABLE_IDENTITY: IdentityChallengeService = {
  requiresEmailVerification: () => false,
  isDeliveryConfigured: () => false,
  senderIds: () => [],
  issue: async () => {
    throw new Error('identity challenge service 不可用');
  },
  consume: async () => {
    throw new Error('identity challenge service 不可用');
  },
};

const UNAVAILABLE_CAPTCHA: CaptchaService = {
  mode: () => 'off',
  isConfigured: () => false,
  providerIds: () => [],
  verify: async () => ({ success: false, reason: 'no_provider' }),
  enforce: async () => undefined,
  clientConfig: () => null,
};

/** Fallback policy service for lifecycle-only unit tests without a host. */
const UNAVAILABLE_NOTIFICATION_POLICY: NotificationPolicyService = {
  listForUser: async () => ({ channels: [], categories: [], types: [] }),
  updateForUser: async () => undefined,
  resetForUser: async () => undefined,
  listPolicy: async () => ({ channels: [], categories: [], types: [] }),
  updatePolicy: async () => ({ channels: [], categories: [], types: [] }),
  isEnabled: async () => true,
  enabledChannels: async () => null,
  inAppExclusions: async () => null,
};

/** Kernel service names a plugin may resolve but never override. */
export const KERNEL_SERVICE_IDS: readonly string[] = Object.freeze(
  KERNEL_SERVICE_ACCESSORS.map((name) => `${KERNEL_SERVICE_OWNER}.${name}`),
);

export type PluginState = 'registered' | 'active' | 'failed';

interface ManagedPlugin {
  definition: PluginDefinition;
  state: PluginState;
  /**
   * Resources tied to the *registered* lifetime of the plugin: the dispatched
   * routes wired at `register`. Disposed only when the plugin is unregistered.
   */
  registrations: DisposableList;
  /**
   * Resources tied to the *active* lifetime: event subscriptions, extension
   * registrations, provided services, and explicit `ctx.effect` bodies. A fresh
   * list is created on every activation and unwound (reverse order) on
   * deactivation, so reactivation cannot accumulate residue and an inactive
   * plugin leaves nothing live behind.
   */
  effects: DisposableList;
  inFlight: number;
  drainWaiters: Array<() => void>;
  workerFailures: number;
  workerCircuitOpen: boolean;
  activating: boolean;
}

/**
 * Microkernel plugin runtime: registration, lifecycle (register/activate/
 * deactivate), extension-point management, and event broadcast. Plugin
 * persistence (enabled flags) lives in the database; the runtime is in-memory.
 */
export class PluginRuntime {
  private readonly plugins = new Map<string, ManagedPlugin>();
  private readonly extensions = new Map<
    string,
    Array<{ pluginId: string; implementation: unknown }>
  >();
  /** Named capability services published by active plugins (name → provider). */
  private readonly services = new Map<string, { pluginId: string; implementation: unknown }>();
  /** `METHOD /path` keys of mounted open-platform aliases (collision guard). */
  private readonly capabilityPaths = new Set<string>();
  /** Open-platform capabilities contributed by this runtime's plugins. */
  private readonly capabilityEntries = new Map<string, PluginCapabilityEntry>();
  private readonly lifecycleLocks = new Map<string, Promise<void>>();

  constructor(private readonly options: PluginRuntimeOptions) {
    setIsolatedWorkerExitHandler((id) => {
      void this.handleWorkerExit(id);
    });
    // ADR-0021 §D3 (minimal): publish the kernel capability services under the
    // reserved `kernel.*` namespace so plugins can resolve them uniformly and
    // cannot squat the names. Registered first, so `provideService` rejects any
    // plugin attempt to override.
    for (const name of KERNEL_SERVICE_ACCESSORS) {
      const implementation =
        name === 'identity'
          ? (options.identity ?? UNAVAILABLE_IDENTITY)
          : name === 'captcha'
            ? (options.captcha ?? UNAVAILABLE_CAPTCHA)
            : name === 'notificationPolicy'
              ? (options.notificationPolicy ?? UNAVAILABLE_NOTIFICATION_POLICY)
              : options[name];
      // Optional services (e.g. `market`) stay absent when a bare runtime is
      // constructed in unit tests; plugins declaring them in `inject` then fail
      // activation loudly instead of resolving `undefined`.
      if (implementation === undefined) continue;
      this.services.set(`${KERNEL_SERVICE_OWNER}.${name}`, {
        pluginId: KERNEL_SERVICE_OWNER,
        implementation,
      });
    }
  }

  private async handleWorkerExit(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin || (plugin.state === 'registered' && !plugin.activating)) return;
    plugin.state = 'failed';
    plugin.workerFailures += 1;
    if (plugin.workerFailures >= ISOLATED_WORKER_FAILURE_THRESHOLD) {
      plugin.workerCircuitOpen = true;
      this.options.logger.error(
        `Plugin worker circuit opened after ${plugin.workerFailures} failures: ${id}`,
      );
    }
    plugin.effects.dispose();
    await this.options.jobs
      .removeByOwner(id)
      .catch((error) =>
        this.options.logger.error(
          `Plugin ${id} cleanup after worker exit failed: ${String(error)}`,
        ),
      );
    this.options.extensions.unregisterModels(id);
    this.options.logger.error(`Plugin worker exited; plugin quarantined: ${id}`);
  }

  /**
   * Serialize lifecycle transitions per plugin id so concurrent activate/
   * deactivate requests cannot double-run onActivate/onDeactivate. Recursive
   * dependency activation uses activateUnlocked internally, so the lock is
   * never held twice for the same plugin.
   */
  private async withLifecycleLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleLocks.get(id) ?? Promise.resolve();
    const run = previous.then(() => fn());
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleLocks.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.lifecycleLocks.get(id) === tail) this.lifecycleLocks.delete(id);
    }
  }

  private wrapRoute(plugin: ManagedPlugin, route: PluginRoute): PluginRoute {
    const handler = route.handler as (...args: unknown[]) => unknown;
    return {
      ...route,
      handler: (async (...args: unknown[]) => {
        plugin.inFlight += 1;
        try {
          return await handler(...args);
        } finally {
          plugin.inFlight -= 1;
          if (plugin.inFlight === 0) {
            for (const resolve of plugin.drainWaiters.splice(0)) resolve();
          }
        }
      }) as never,
    } as PluginRoute;
  }

  private waitForDrain(plugin: ManagedPlugin): Promise<void> {
    if (plugin.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => plugin.drainWaiters.push(resolve));
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  isActive(id: string): boolean {
    return this.plugins.get(id)?.state === 'active';
  }

  list(): Array<{
    id: string;
    name: string;
    description: string | undefined;
    version: string;
    state: PluginState;
    requires: PluginDependency[];
    provides: string[];
    consumes: PluginExtensionConsumer[];
    permissions: string[];
    roleTemplates: PluginRoleTemplate[];
    locales: string[];
    /** Kernel-derived built-in flag (same source as the backend execution decision). */
    builtin: boolean;
    /** Execution mode applied by `loadPluginDefinition`. */
    execution: 'trusted' | 'isolated';
    /** Explicit platform grant for web-process server execution (contract 03 §3.1). */
    frontendExecutions: 'declarative' | 'server';
  }> {
    return [...this.plugins.values()].map((p) => ({
      id: p.definition.manifest.id,
      name: p.definition.manifest.name,
      description: p.definition.manifest.description,
      version: p.definition.manifest.version,
      state: p.state,
      requires: normalizePluginDependencies(p.definition.manifest.requires),
      provides: p.definition.manifest.provides ?? [],
      consumes: p.definition.manifest.consumes ?? [],
      permissions: normalizePluginPermissions(p.definition.manifest.permissions).map(
        (permission) => permission.key,
      ),
      roleTemplates: p.definition.manifest.roleTemplates ?? [],
      locales: p.definition.manifest.locales ?? [],
      builtin: p.definition.manifest.builtin === true,
      // Mirror `loadPluginDefinition` (plugins.ts): built-ins are always
      // trusted; a non-built-in defaults to isolated in production.
      execution:
        p.definition.manifest.execution ??
        (process.env.NODE_ENV === 'production' ? 'isolated' : 'trusted'),
      frontendExecutions: p.definition.manifest.frontendExecutions ?? 'declarative',
    }));
  }

  /** Whether a plugin's `permissions` should be treated as granted to the admin group. */
  private readonly adminGroupId = 'group_admin';

  async register(definition: PluginDefinition): Promise<void> {
    const id = definition.manifest.id;
    if (this.plugins.has(id)) {
      throw new Error(`插件已注册：${id}`);
    }
    const plugin: ManagedPlugin = {
      definition,
      state: 'registered',
      registrations: new DisposableList(),
      effects: new DisposableList(),
      inFlight: 0,
      drainWaiters: [],
      workerFailures: 0,
      workerCircuitOpen: false,
      activating: false,
    };
    this.plugins.set(id, plugin);
    try {
      // Routes are wired at registration onto the HTTP dispatcher; the isActive
      // guard makes them 404 while the plugin is inactive. They belong to the
      // registered lifetime, so they outlive deactivate/reactivate cycles.
      const routes = definition.routes ?? [];
      for (const route of routes) {
        const dispose = this.options.registerRoute(
          id,
          this.wrapRoute(plugin, route),
          () => plugin.state === 'active',
        );
        plugin.registrations.push(dispose);
      }
      // Open-platform aliases derived from `manifest.capabilities`: the same
      // plugin handler is re-exposed under `/api/v1` behind the same guard, with
      // per-token quota + audit. A capability must name one of the plugin's own
      // routes, so the alias can never call an implementation that does not
      // exist (ADR-0001 — no second implementation).
      await this.mountCapabilities(id, definition, plugin);
      if (definition.onRegister) {
        await definition.onRegister(this.context(definition));
      }
    } catch (err) {
      for (const entry of [...this.capabilityEntries.values()]) {
        if (entry.pluginId === id) this.capabilityEntries.delete(entry.id);
      }
      for (const capability of definition.manifest.capabilities ?? []) {
        this.capabilityPaths.delete(`${capability.method} ${capability.path}`);
      }
      this.options.removeRoutes(id);
      plugin.registrations.dispose();
      plugin.effects.dispose();
      stopIsolatedPlugin(id);
      this.plugins.delete(id);
      throw err;
    }
    this.options.logger.info(`Plugin registered: ${id}`);
  }

  /** Validate `manifest.capabilities` and mount each as a `/api/v1` alias. */
  private async mountCapabilities(
    id: string,
    definition: PluginDefinition,
    plugin: ManagedPlugin,
  ): Promise<void> {
    const capabilities = definition.manifest.capabilities ?? [];
    if (capabilities.length === 0) return;
    const routes = definition.routes ?? [];
    const entries: PluginCapabilityEntry[] = [];

    for (const capability of capabilities) {
      const route = routes.find(
        (candidate) =>
          candidate.method === capability.method && candidate.path === capability.route,
      );
      if (!route) {
        throw new Error(
          `插件 ${id} 的能力项 ${capability.id} 指向未声明的路由 ${capability.method} ${capability.route}`,
        );
      }
      if (route.kind === 'raw') {
        throw new Error(`插件 ${id} 的能力项 ${capability.id} 不能指向 raw 路由`);
      }
      if (!capability.path.startsWith('/api/v1/')) {
        throw new Error(`插件 ${id} 的能力项 ${capability.id} 的公开路径必须以 /api/v1/ 开头`);
      }
      if (this.capabilityPaths.has(`${capability.method} ${capability.path}`)) {
        throw new Error(`插件 ${id} 的能力项路径冲突：${capability.method} ${capability.path}`);
      }
      this.capabilityPaths.add(`${capability.method} ${capability.path}`);

      // The alias inherits the internal guard verbatim — permission and auth are
      // never widened on the public surface. When the capability declares a
      // refined `资源:read|write` scope (slice four), the refined scope replaces
      // the coarse permission as the gate: it is strictly narrower because
      // issuance requires the owner to hold the coarse resource permission, so
      // access can only shrink, and a read scope cannot perform a write.
      const alias: PluginRoute = {
        method: capability.method,
        path: capability.path,
        ...(route.auth ? { auth: route.auth } : {}),
        ...(!capability.scope && route.permission ? { permission: route.permission } : {}),
        handler: route.handler,
      };
      const dispose = this.options.registerRoute(
        id,
        this.wrapRoute(plugin, alias),
        () => plugin.state === 'active',
        {
          capabilityId: capability.id,
          mutating: capability.mutating ?? capability.method !== 'GET',
          ...(capability.scope ? { scope: capability.scope } : {}),
        },
      );
      plugin.registrations.push(dispose);

      entries.push({
        id: capability.id,
        method: capability.method,
        path: capability.path,
        scope: capability.scope ?? route.permission ?? null,
        summary: capability.summary,
        mutating: capability.mutating ?? capability.method !== 'GET',
        ...(capability.destructive !== undefined ? { destructive: capability.destructive } : {}),
        pluginId: id,
      });
    }
    for (const entry of entries) {
      this.capabilityEntries.set(entry.id, entry);
    }
  }

  /** Open-platform capabilities contributed by this runtime's plugins. */
  listCapabilities(): Capability[] {
    return [...this.capabilityEntries.values()].filter((entry) => this.isActive(entry.pluginId));
  }

  /**
   * Runtime-aggregated refined-scope governance (ADR-0021 §D1): the resource →
   * coarse-permission table merged from every registered plugin's
   * `PluginPermission.scope`, on top of the kernel's own resources. Consumers
   * (`auth.ts`, `api-tokens.ts`, open API, MCP) read this instead of a kernel
   * hardcoded map, so the kernel never names a business plugin's permissions.
   *
   * A registered-but-inactive plugin still contributes: its declared
   * permissions are seeded into the DB regardless of activation, and dropping
   * them on deactivate would silently invalidate existing token scopes.
   */
  scopeGovernance(): ScopeGovernance {
    const declared = [...this.plugins.values()].map((plugin) =>
      normalizePluginPermissions(plugin.definition.manifest.permissions),
    );
    return aggregateScopeGovernance(declared);
  }

  /**
   * Remove a plugin entirely: deactivate if active, drop its dispatched routes
   * and extensions, then forget it.
   *
   * `retainData` distinguishes the two callers this serves:
   *   - **Upgrade / reload** (`retainData: true`): the plugin is being replaced
   *     in place. Its custom-model tables must survive so content authored under
   *     the previous version is not destroyed by a redeploy. The tables are
   *     re-adopted by `registerModels` on the next activation.
   *   - **Uninstall** (default): the plugin is leaving for good, so each model's
   *     `retention` policy is honoured (`delete` drops the table, `retain`
   *     keeps it).
   */
  async unregister(id: string, options: { retainData?: boolean } = {}): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    if (plugin.state === 'active') {
      await this.deactivate(id);
    }
    plugin.effects.dispose();
    plugin.registrations.dispose();
    this.options.removeRoutes(id);
    for (const entry of [...this.capabilityEntries.values()]) {
      if (entry.pluginId === id) this.capabilityEntries.delete(entry.id);
    }
    for (const capability of plugin.definition.manifest.capabilities ?? []) {
      this.capabilityPaths.delete(`${capability.method} ${capability.path}`);
    }
    this.plugins.delete(id);
    stopIsolatedPlugin(id);
    if (options.retainData) {
      // Keep the physical tables; only forget the in-memory registry entries so
      // a stale model kind cannot be queried between unregister and re-register.
      this.options.extensions.unregisterModels(id);
    } else {
      await this.options.extensions.applyRetention(id, plugin.definition.customModels);
    }
    this.options.logger.info(`Plugin unregistered: ${id}`);
  }

  async activate(id: string): Promise<void> {
    return this.withLifecycleLock(id, () => this.activateUnlocked(id));
  }

  private async activateUnlocked(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) {
      throw new Error(`插件不存在：${id}`);
    }
    this.assertNoDependencyCycle(id);
    for (const dependency of normalizePluginDependencies(plugin.definition.manifest.requires)) {
      const target = this.plugins.get(dependency.id);
      if (!target) {
        if (dependency.optional) continue;
        throw new Error(`插件 ${id} 缺少依赖插件 ${dependency.id}`);
      }
      if (
        dependency.range &&
        !semver.satisfies(target.definition.manifest.version, dependency.range)
      ) {
        if (dependency.optional) continue;
        throw new Error(
          `插件 ${id} 需要 ${dependency.id}@${dependency.range}，当前为 ${target.definition.manifest.version}`,
        );
      }
      await this.activate(dependency.id);
    }
    this.validateConsumes(id);
    this.validateInject(id);
    if (plugin.state === 'active') {
      return;
    }
    if (plugin.state === 'failed') {
      if (plugin.workerCircuitOpen) {
        throw new Error(`插件 ${id} worker 已熔断，请重新注册插件或部署修复版本后再试`);
      }
      plugin.activating = true;
      try {
        await restartIsolatedPlugin(id);
        plugin.state = 'registered';
      } catch (error) {
        plugin.activating = false;
        throw error;
      }
    } else {
      plugin.activating = true;
    }
    // Activation effects are scoped to this activation: start from a fresh
    // list so a deactivate/reactivate cycle never reads a disposed list (which
    // would silently drop every registration) or accumulates stale ones.
    plugin.effects = new DisposableList();
    try {
      // Build/migrate the plugin's model tables before it activates, so its
      // `onActivate` can already read and write its own data.
      await this.options.extensions.registerModels(id, plugin.definition.customModels);
      for (const listener of plugin.definition.eventListeners ?? []) {
        const unsubscribe = this.options.events.subscribe(listener.topic, listener.handler);
        plugin.effects.push(unsubscribe);
      }
      if (plugin.definition.onActivate) {
        await plugin.definition.onActivate(this.context(plugin.definition));
      }
      if ((plugin as ManagedPlugin).state === 'failed') {
        throw new Error(`插件 ${id} worker 在激活过程中退出`);
      }
      plugin.state = 'active';
    } catch (err) {
      plugin.effects.dispose();
      if ((plugin as ManagedPlugin).state !== 'failed') plugin.state = 'registered';
      plugin.activating = false;
      this.options.extensions.unregisterModels(id);
      throw err;
    }
    plugin.activating = false;
    this.options.events.publish('plugin.activated', { pluginId: id });
    await this.registerPluginPermissions(plugin.definition);
    this.options.logger.info(`Plugin activated: ${id}`);
  }

  async deactivate(id: string): Promise<void> {
    return this.withLifecycleLock(id, () => this.deactivateUnlocked(id));
  }

  private async deactivateUnlocked(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) {
      throw new Error(`插件不存在：${id}`);
    }
    if (plugin.state !== 'active') {
      return;
    }
    const dependents = this.activeDependents(id);
    if (dependents.length > 0) {
      throw new Error(`插件 ${id} 被已启用的插件依赖：${dependents.join(', ')}`);
    }
    if (plugin.definition.onDeactivate) {
      await plugin.definition.onDeactivate(this.context(plugin.definition));
    }
    plugin.state = 'registered';
    await this.waitForDrain(plugin);
    plugin.effects.dispose();
    this.options.events.publish('plugin.deactivated', { pluginId: id });
    this.options.extensions.unregisterModels(id);
    // Jobs are owned per plugin; drop handlers, schedules and recurring work so
    // an inactive plugin leaves nothing running on any replica.
    await this.options.jobs.removeByOwner(id);
    this.options.logger.info(`Plugin deactivated: ${id}`);
  }

  private activeDependents(id: string): string[] {
    return [...this.plugins.values()]
      .filter(
        (plugin) =>
          plugin.state === 'active' &&
          normalizePluginDependencies(plugin.definition.manifest.requires).some(
            (dependency) => dependency.id === id,
          ),
      )
      .map((plugin) => plugin.definition.manifest.id);
  }

  private assertNoDependencyCycle(start: string): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) {
        throw new Error(`插件依赖出现循环：${id}`);
      }
      if (visited.has(id)) return;
      visiting.add(id);
      const plugin = this.plugins.get(id);
      for (const dependency of normalizePluginDependencies(plugin?.definition.manifest.requires)) {
        if (this.plugins.has(dependency.id)) visit(dependency.id);
      }
      visiting.delete(id);
      visited.add(id);
    };
    visit(start);
  }

  private validateConsumes(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    for (const consumer of plugin?.definition.manifest.consumes ?? []) {
      const target = this.plugins.get(consumer.pluginId);
      const satisfied =
        target?.state === 'active' &&
        (target.definition.manifest.provides ?? []).includes(consumer.extensionPoint);
      if (satisfied || consumer.optional) continue;
      throw new Error(
        `插件 ${pluginId} 消费了不存在的扩展点 ${consumer.pluginId}:${consumer.extensionPoint}`,
      );
    }
  }

  private validateInject(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    for (const name of plugin?.definition.inject ?? []) {
      if (!this.services.has(name)) {
        throw new Error(`插件 ${pluginId} 缺少注入服务 ${name}`);
      }
    }
  }

  /** Publish a named capability service for other plugins to inject. */
  private provideService(name: string, implementation: unknown, pluginId: string): () => void {
    const existing = this.services.get(name);
    if (existing && existing.pluginId !== pluginId) {
      throw new Error(`服务名 ${name} 已被插件 ${existing.pluginId} 占用`);
    }
    this.services.set(name, { pluginId, implementation });
    return () => {
      const current = this.services.get(name);
      if (current?.implementation === implementation) {
        this.services.delete(name);
      }
    };
  }

  /** Resolve a service published by any plugin. */
  getService<T>(name: string): T | undefined {
    return this.services.get(name)?.implementation as T | undefined;
  }

  /** Resolve a required service, throwing a clear error when it is absent. */
  requireService<T>(name: string): T {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`服务 ${name} 不可用`);
    }
    return service.implementation as T;
  }

  registerExtension<T>(pointId: string, implementation: T, pluginId: string): () => void {
    const list = this.extensions.get(pointId) ?? [];
    list.push({ pluginId, implementation });
    this.extensions.set(pointId, list);
    return () => {
      const index = list.findIndex((entry) => entry.implementation === implementation);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }

  /** Upsert a plugin's declared permissions and grant them to the admin group. */
  private async registerPluginPermissions(definition: PluginDefinition): Promise<void> {
    const declared = normalizePluginPermissions(definition.manifest.permissions);
    const db = this.options.db as PrismaClient;

    // 1) Upsert every declared permission and grant it to the admin group.
    for (const { key, name, description } of declared) {
      const permission = await db.permission.upsert({
        where: { key },
        create: {
          key,
          name: name ?? `${definition.manifest.id}.${key}`,
          description: description ?? null,
        },
        // Refresh metadata whenever the plugin declares a label/description; leave
        // the row untouched when it does not (e.g. an auto-granted roleTemplate key).
        update: {
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
        },
      });
      await db.groupPermission.upsert({
        where: {
          groupId_permissionId: { groupId: this.adminGroupId, permissionId: permission.id },
        },
        create: { groupId: this.adminGroupId, permissionId: permission.id },
        update: {},
      });
    }

    // 2) Apply role templates: grant the template permissions to the matching
    //    built-in group (ADMIN → group_admin, USER → group_user). This keeps the
    //    declarative roleTemplates authoritative for default group membership.
    for (const template of definition.manifest.roleTemplates ?? []) {
      const groupId = template.role === 'ADMIN' ? 'group_admin' : 'group_user';
      for (const key of template.permissions ?? []) {
        const permission = await db.permission.upsert({
          where: { key },
          create: { key, name: `${definition.manifest.id}.${key}` },
          update: {},
        });
        await db.groupPermission.upsert({
          where: { groupId_permissionId: { groupId, permissionId: permission.id } },
          create: { groupId, permissionId: permission.id },
          update: {},
        });
      }
    }
  }

  getExtensions<T>(pointId: string): T[] {
    return (this.extensions.get(pointId) ?? []).map((entry) => entry.implementation as T);
  }

  /** Read extension implementations together with their owning plugin id. */
  getExtensionsWithOwner<T>(pointId: string): Array<{ pluginId: string; implementation: T }> {
    return (this.extensions.get(pointId) ?? []).map((entry) => ({
      pluginId: entry.pluginId,
      implementation: entry.implementation as T,
    }));
  }

  private context(definition: PluginDefinition): PluginContext {
    const pluginId = definition.manifest.id;
    const base = this.options.logger;
    const logger: PluginLogger = {
      info: (message: string) => base.info(`[plugin:${pluginId}] ${message}`),
      warn: (message: string) => base.warn(`[plugin:${pluginId}] ${message}`),
      error: (message: string) => base.error(`[plugin:${pluginId}] ${message}`),
    };
    return {
      manifest: definition.manifest,
      logger,
      events: this.options.events,
      extensions: this.options.extensions.client(pluginId, null),
      tx: <T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T> => {
        if (txContext.getStore()) {
          return Promise.reject(new ExtensionValidationError('不允许嵌套 ctx.tx'));
        }
        const prisma = this.options.db as PrismaClient;
        return txContext.run(true, () =>
          prisma
            .$transaction(async (trx) => {
              const wallet: ExtensionTransaction['wallet'] = {
                debit: (userId, amount, currency, ref) =>
                  this.options.wallet.debit(userId, amount, currency, ref, trx),
                credit: (userId, amount, currency, ref) =>
                  this.options.wallet.credit(userId, amount, currency, ref, trx),
                hold: (userId, amount, currency, ref, options) =>
                  this.options.wallet.hold(userId, amount, currency, ref, {
                    ...(options ?? {}),
                    tx: trx,
                  }),
                settleHold: (holdId, settledAmount, ref) =>
                  this.options.wallet.settleHold(holdId, settledAmount, ref, trx),
                releaseHold: (holdId) => this.options.wallet.releaseHold(holdId, trx),
              };
              const payments: ExtensionTransaction['payments'] = {
                createRecord: (input) => this.options.payments.createRecord(input, trx),
              };
              // W1: buffer events registered via `tx.publish` and flush them into
              // the outbox on the SAME `trx` after `fn` resolves (before commit).
              // A rollback discards the buffer, so no orphan event row survives.
              const pending: Array<{ topic: string; body: string }> = [];
              const tx: ExtensionTransaction = {
                extensions: this.options.extensions.clientWith(
                  trx as unknown as RawDatabase,
                  pluginId,
                  null,
                ),
                wallet,
                payments,
                publish: (topic, payload) => {
                  pending.push({
                    topic,
                    body: serializeOutboxBody(topic, payload, outboxOrigin()),
                  });
                },
              };
              const result = await fn(tx);
              for (const event of pending) {
                await trx.outboxEvent.create({
                  data: {
                    topic: event.topic,
                    payload: { body: event.body },
                    origin: outboxOrigin(),
                  },
                });
              }
              return result;
            })
            .then((result) => {
              // Commit succeeded: nudge the relay so latency does not depend on
              // the poll interval. Delivery itself stays relay-owned (no inline
              // local deliver) to preserve the single-delivery guarantee.
              if (isOutboxBus(this.options.events)) {
                this.options.events.nudgeRelay();
              }
              return result;
            }),
        );
      },
      payments: this.options.payments,
      wallet: this.options.wallet,
      fx: this.options.fx,
      currency: this.options.currency ?? STATIC_CURRENCY_SERVICE,
      auth: this.options.auth,
      notifications: this.options.notifications,
      notificationPolicy: this.options.notificationPolicy ?? UNAVAILABLE_NOTIFICATION_POLICY,
      identity: this.options.identity ?? UNAVAILABLE_IDENTITY,
      captcha: this.options.captcha ?? UNAVAILABLE_CAPTCHA,
      state: this.options.state,
      cache: this.options.cache ?? getCacheService(),
      jobs: createKernelJobContext(pluginId, this.options.jobs),
      storage: this.options.storage ?? createStorageService(),
      media: this.options.media
        ? (() => {
            const media = this.options.media as MediaReferenceService;
            return {
              register: (input: Parameters<MediaReferenceService['register']>[0]) =>
                media.register({ ...input, ownerPluginId: pluginId }),
              unregister: (input: Parameters<MediaReferenceService['unregister']>[0]) =>
                media.unregister({ ...input, ownerPluginId: pluginId }),
              unregisterResource: (resourceType: string, resourceId: string) =>
                media.unregisterResource(resourceType, resourceId, pluginId),
            };
          })()
        : {
            register: async () => undefined,
            unregister: async () => undefined,
            unregisterResource: async () => undefined,
          },
      secrets: pluginSecrets(this.options.db as PrismaClient, pluginId),
      effect: (fn) => {
        const dispose = runEffect(fn);
        const untrack = this.plugins.get(pluginId)?.effects.push(dispose);
        return () => {
          dispose();
          untrack?.();
        };
      },
      registerExtension: <T>(pointId: string, implementation: T) => {
        const unregister = this.registerExtension(pointId, implementation, pluginId);
        const untrack = this.plugins.get(pluginId)?.effects.push(unregister);
        return () => {
          unregister();
          untrack?.();
        };
      },
      provide: <T>(name: string, implementation: T) => {
        const unregister = this.provideService(name, implementation, pluginId);
        const untrack = this.plugins.get(pluginId)?.effects.push(unregister);
        return () => {
          unregister();
          untrack?.();
        };
      },
      getService: <T>(name: string) => this.getService<T>(name),
      requireService: <T>(name: string) => this.requireService<T>(name),
      getExtensions: <T>(pointId: string) => this.getExtensions<T>(pointId),
      getExtensionsWithOwner: <T>(pointId: string) => this.getExtensionsWithOwner<T>(pointId),
    };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    pluginRuntime: PluginRuntime;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    payments: PaymentService;
    wallet: WalletService;
    fx: FxService;
    currency: CurrencyService;
    auth: KernelAuth;
  }
}
