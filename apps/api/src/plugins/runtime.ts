import type {
  AuthService,
  EventBus,
  FxService,
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
import { DisposableList, normalizePluginDependencies, runEffect } from '@stackpanel/sdk';
import type { ExtensionTransaction } from '@stackpanel/sdk';
import { ExtensionValidationError } from '@stackpanel/sdk';
import { AsyncLocalStorage } from 'node:async_hooks';
import semver from 'semver';
import type { PrismaClient } from '@stackpanel/db';
import { pluginSecrets } from '../lib/crypto.ts';
import { createKernelJobContext } from '../jobs/kernel-jobs.ts';
import type { JobRuntime } from '../jobs/types.ts';
import type { PluginExtensionRuntime } from '../extensions/service.ts';
import type { RawDatabase } from '../extensions/client.ts';
import {
  type Capability,
  type PluginCapabilityEntry,
} from '../lib/capability-registry.ts';

/** Tracks an in-flight `ctx.tx` so nested calls fail with a clear error. */
const txContext = new AsyncLocalStorage<true>();

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
  /** Kernel-provided database handle exposed to plugins via ctx.db. */
  db: unknown;
  /** Kernel-owned payment orchestration exposed to plugins via ctx.payments. */
  payments: PaymentService;
  /** Kernel-owned wallet service exposed to plugins via ctx.wallet. */
  wallet: WalletService;
  /** Kernel-owned FX service exposed to plugins via ctx.fx. */
  fx: FxService;
  /** Kernel-owned auth capabilities exposed to plugins via ctx.auth. */
  auth: AuthService;
  /** Kernel-owned notification service exposed to plugins via ctx.notifications. */
  notifications: NotificationsService;
  /** Kernel-owned shared state (counters, TTL keys, locks) via ctx.state. */
  state: StateService;
  /** Kernel-owned background jobs (enqueue/schedule/handle) via ctx.jobs. */
  jobs: JobRuntime;
  /** Extension engine: owns plugin model tables, clients and finalizers. */
  extensions: PluginExtensionRuntime;
}

export type PluginState = 'registered' | 'active';

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

  constructor(private readonly options: PluginRuntimeOptions) {}

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
      permissions: p.definition.manifest.permissions ?? [],
      roleTemplates: p.definition.manifest.roleTemplates ?? [],
      locales: p.definition.manifest.locales ?? [],
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
    };
    this.plugins.set(id, plugin);
    try {
      // Routes are wired at registration onto the HTTP dispatcher; the isActive
      // guard makes them 404 while the plugin is inactive. They belong to the
      // registered lifetime, so they outlive deactivate/reactivate cycles.
      const routes = definition.routes ?? [];
      for (const route of routes) {
        const dispose = this.options.registerRoute(id, route, () => plugin.state === 'active');
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
      const dispose = this.options.registerRoute(id, alias, () => plugin.state === 'active', {
        capabilityId: capability.id,
        mutating: capability.mutating ?? capability.method !== 'GET',
        ...(capability.scope ? { scope: capability.scope } : {}),
      });
      plugin.registrations.push(dispose);

      entries.push({
        id: capability.id,
        method: capability.method,
        path: capability.path,
        scope: capability.scope ?? route.permission ?? null,
        summary: capability.summary,
        mutating: capability.mutating ?? capability.method !== 'GET',
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
   * Remove a plugin entirely: deactivate if active, drop its dispatched routes
   * and extensions, then forget it. Used by hot upgrade/uninstall.
   */
  async unregister(id: string): Promise<void> {
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
    await this.options.extensions.applyRetention(id, plugin.definition.customModels);
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
      plugin.state = 'active';
      if (plugin.definition.onActivate) {
        await plugin.definition.onActivate(this.context(plugin.definition));
      }
    } catch (err) {
      plugin.effects.dispose();
      plugin.state = 'registered';
      this.options.extensions.unregisterModels(id);
      throw err;
    }
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
    plugin.effects.dispose();
    plugin.state = 'registered';
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
    const permissions = definition.manifest.permissions ?? [];
    const db = this.options.db as PrismaClient;

    // 1) Upsert every declared permission and grant it to the admin group.
    for (const key of permissions) {
      const permission = await db.permission.upsert({
        where: { key },
        create: { key, name: `${definition.manifest.id}.${key}` },
        update: {},
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
      db: this.options.db,
      extensions: this.options.extensions.client(pluginId, null),
      tx: <T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T> => {
        if (txContext.getStore()) {
          return Promise.reject(new ExtensionValidationError('不允许嵌套 ctx.tx'));
        }
        const prisma = this.options.db as PrismaClient;
        return txContext.run(true, () =>
          prisma.$transaction(async (trx) => {
            const wallet: ExtensionTransaction['wallet'] = {
              debit: (userId, amount, currency, ref) =>
                this.options.wallet.debit(userId, amount, currency, ref, trx),
              credit: (userId, amount, currency, ref) =>
                this.options.wallet.credit(userId, amount, currency, ref, trx),
            };
            const payments: ExtensionTransaction['payments'] = {
              createRecord: (input) => this.options.payments.createRecord(input, trx),
            };
            return fn({
              extensions: this.options.extensions.clientWith(
                trx as unknown as RawDatabase,
                pluginId,
                null,
              ),
              wallet,
              payments,
            });
          }),
        );
      },
      payments: this.options.payments,
      wallet: this.options.wallet,
      fx: this.options.fx,
      auth: this.options.auth,
      notifications: this.options.notifications,
      state: this.options.state,
      jobs: createKernelJobContext(pluginId, this.options.jobs),
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
    auth: AuthService;
  }
}
