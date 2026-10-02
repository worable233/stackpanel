/**
 * Extension 引擎：kind 注册表（ADR-0009 §1/§3）。
 *
 * 一个 kind 全局唯一、只属一个插件。插件激活时把声明注册进来（建表后），
 * 停用时注销；客户端按插件身份解析 kind，访问他人 kind 直接拒绝。
 */

import type { CustomModelDefinition } from '@stackpanel/sdk';
import { ExtensionUnknownKind } from '@stackpanel/sdk';
import type { ExtensionTable } from './schema.ts';

export interface RegisteredModel {
  pluginId: string;
  definition: CustomModelDefinition;
  table: ExtensionTable;
}

export class ExtensionRegistry {
  private readonly models = new Map<string, RegisteredModel>();

  /** Register or replace one model owned by `pluginId`. */
  register(pluginId: string, definition: CustomModelDefinition, table: ExtensionTable): void {
    const existing = this.models.get(definition.kind);
    if (existing && existing.pluginId !== pluginId) {
      throw new Error(`Extension kind ${definition.kind} 已被插件 ${existing.pluginId} 占用`);
    }
    this.models.set(definition.kind, { pluginId, definition, table });
  }

  /** Drop every model owned by a plugin (used on deactivate/uninstall). */
  unregisterPlugin(pluginId: string): void {
    for (const [kind, model] of this.models) {
      if (model.pluginId === pluginId) this.models.delete(kind);
    }
  }

  /** Resolve a model for a plugin, enforcing ownership. */
  resolve(pluginId: string, model: CustomModelDefinition): RegisteredModel {
    const registered = this.models.get(model.kind);
    if (!registered || registered.pluginId !== pluginId) {
      throw new ExtensionUnknownKind(model.kind);
    }
    return registered;
  }

  byKind(kind: string): RegisteredModel | undefined {
    return this.models.get(kind);
  }

  list(): RegisteredModel[] {
    return [...this.models.values()];
  }

  listByPlugin(pluginId: string): RegisteredModel[] {
    return [...this.models.values()].filter((model) => model.pluginId === pluginId);
  }
}
