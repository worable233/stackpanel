/**
 * Extension 引擎服务：把注册表、迁移器、能力化客户端与 finalizer 存储组装成
 * 内核交给插件运行时的一件依赖（PLAN-E1 §4.1）。
 *
 * 所有权：`apps/api/src/extensions/**`（E1 独占）。内核只在 `plugin-host.ts` /
 * `runtime.ts` 里接线，不感知具体实现。
 */

import type { CustomModelDefinition, ExtensionClient, ExtensionFinalizer } from '@stackpanel/sdk';
import type { PrismaClient } from '@stackpanel/db';
import { FinalizerStore, createExtensionClient, type RawDatabase } from './client.ts';
import { dropExtensionTable, ensureExtensionModels } from './migrator.ts';
import { ExtensionRegistry, type RegisteredModel } from './registry.ts';
import { compileTable, type ExtensionTable } from './schema.ts';

/**
 * The slice of the engine the plugin runtime depends on. Kept as an interface so
 * the runtime (and its unit tests) never bind to the concrete service.
 */
export interface PluginExtensionRuntime {
  registerModels(
    pluginId: string,
    definitions: readonly CustomModelDefinition[] | undefined,
  ): Promise<void>;
  unregisterModels(pluginId: string): void;
  applyRetention(
    pluginId: string,
    definitions: readonly CustomModelDefinition[] | undefined,
  ): Promise<void>;
  client(pluginId: string, ownerId: string | null): ExtensionClient;
  clientWith(db: RawDatabase, pluginId: string, ownerId: string | null): ExtensionClient;
}

export class ExtensionService implements PluginExtensionRuntime {
  readonly registry = new ExtensionRegistry();
  private readonly finalizers = new FinalizerStore();

  constructor(private readonly prisma: PrismaClient) {}

  /** Create/migrate a plugin's tables, then register the models. */
  async registerModels(
    pluginId: string,
    definitions: readonly CustomModelDefinition[] | undefined,
  ): Promise<void> {
    const tables = await ensureExtensionModels(this.prisma, pluginId, definitions);
    (definitions ?? []).forEach((definition, index) => {
      const table = tables[index];
      if (table) this.registry.register(pluginId, definition, table);
    });
  }

  /** Forget a plugin's models (tables are kept for a later reactivation). */
  unregisterModels(pluginId: string): void {
    this.registry.unregisterPlugin(pluginId);
    this.finalizers.clearPlugin(pluginId);
  }

  /**
   * Uninstall: honour each model's `retention`. `delete` drops the table and its
   * metadata, `retain` keeps both. Registry entries and finalizers are dropped.
   */
  async applyRetention(
    pluginId: string,
    definitions: readonly CustomModelDefinition[] | undefined,
  ): Promise<void> {
    for (const definition of definitions ?? []) {
      if (definition.retention === 'retain') continue;
      await dropExtensionTable(this.prisma, compileTable(definition));
    }
    this.registry.unregisterPlugin(pluginId);
    this.finalizers.clearPlugin(pluginId);
  }

  /** Build a capability-scoped client for a plugin. */
  client(pluginId: string, ownerId: string | null): ExtensionClient {
    return this.clientWith(this.prisma, pluginId, ownerId);
  }

  /** Build a client over an arbitrary handle (used to join `ctx.tx`). */
  clientWith(db: RawDatabase, pluginId: string, ownerId: string | null): ExtensionClient {
    return createExtensionClient({
      db,
      registry: this.registry,
      pluginId,
      ownerId,
      finalizers: this.finalizers,
    });
  }

  /** Register a finalizer for one of a plugin's models. */
  registerFinalizer(
    pluginId: string,
    model: CustomModelDefinition,
    name: string,
    handler: ExtensionFinalizer,
  ): void {
    if (!(model.finalizers ?? []).includes(name)) {
      throw new Error(`模型 ${model.kind} 未声明 finalizer ${name}`);
    }
    this.finalizers.set(pluginId, model.kind, name, handler);
  }

  /** Every model declared by currently active plugins (admin view + routes). */
  list(): RegisteredModel[] {
    return this.registry.list();
  }

  byKind(kind: string): RegisteredModel | undefined {
    return this.registry.byKind(kind);
  }

  /** Reserved for tests/admin: the compiled table of a registered model. */
  tableOf(kind: string): ExtensionTable | undefined {
    return this.registry.byKind(kind)?.table;
  }
}
