import type { z } from 'zod';

/**
 * Custom model system (Halo Extension CR equivalent).
 * A plugin declares one or more models with `defineModel`. Each model has a
 * namespaced kind (e.g. `cms/post`) and a zod schema for its payload. The kernel
 * generates one real table per model (`ext_<ns>_<name>`) and exposes typed
 * access through `ctx.extensions`; a generic REST surface lives under
 * `/custom/<namespace>/<name>` (e.g. `/custom/cms/post`) with permission checks
 * and schema validation — no plugin DDL, no Prisma schema changes.
 *
 * The plugin declares models in its `PluginDefinition.customModels`; the kernel
 * builds/migrates the tables at activation and tears the routes down at
 * deactivation. Both plugins and the frontend consume the plain REST API.
 */

/** Column type of one indexed field (declared explicitly, never inferred). */
export type ModelFieldType = 'string' | 'integer' | 'number' | 'boolean';

/**
 * A queryable field of a model. `fields` are top-level paths relative to the
 * model payload; the kernel generates one real indexed column per path. Nested
 * paths (`a.b`) are rejected — declare the scalar you actually filter on.
 */
export interface ModelIndex {
  /** Top-level paths into the payload; no `.`, no duplicates, at least one. */
  fields: string[];
  /** Unique index. The kernel verifies existing rows before applying it. */
  unique?: boolean;
  /** Explicit column type for every declared field. */
  types: Record<string, ModelFieldType>;
}

/** Declarative metadata for a plugin-defined model. */
export interface CustomModelDefinition {
  /** Namespaced kind, e.g. `cms/post`. Must match `^[a-z0-9_-]+/[a-z0-9_-]+$`. */
  kind: string;
  /** Human-friendly label shown in the admin UI. */
  label: string;
  /** Permission required to mutate instances (default `custom.<kind>.write`). */
  permission?: string;
  /** Permission required to read instances (default `custom.<kind>.read`). */
  readPermission?: string;
  /** When true, instances are scoped to their creating user (ownerId). */
  scoped?: boolean;
  /** Zod schema validating the `data` payload of each instance. */
  schema: z.ZodType<unknown>;
  /**
   * Queryable fields. The kernel generates a real indexed column per field and
   * only these (plus `name`/`ownerId`/`createdAt`/`updatedAt`) may appear in a
   * query. Undeclared payload fields still persist, they are just not queryable.
   */
  indexes?: ModelIndex[];
  /** Named finalizers run in order when an instance is deleted. */
  finalizers?: string[];
  /** What happens to the model's data when the plugin is uninstalled. */
  retention?: 'delete' | 'retain';
}

/** A stored custom resource instance (serialized over the REST API). */
export interface CustomResource<T = unknown> {
  id: string;
  kind: string;
  data: T;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A single custom resource instance (REST request/response shape). */
export interface CustomResourceInstance {
  id: string;
  kind: string;
  data: Record<string, unknown>;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** List response for GET /custom/:ns/:name. */
export interface CustomResourceList {
  items: CustomResourceInstance[];
  total: number;
  page: number;
  pageSize: number;
}

/** PascalCase-identifier test for generated table/column/index names. */
const MODEL_FIELD_TYPES = new Set<ModelFieldType>(['string', 'integer', 'number', 'boolean']);

/**
 * Declare a plugin-defined model. Returns the declarative definition to be
 * placed in `PluginDefinition.customModels`. The kernel owns storage, DDL and
 * query planning; this function only validates the shape at authoring time so
 * mistakes surface at plugin load rather than on the first request.
 */
export function defineModel(definition: CustomModelDefinition): CustomModelDefinition {
  if (!/^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(definition.kind)) {
    throw new Error(`自定义模型 kind 无效：${definition.kind}（应为 命名空间/名称）`);
  }
  for (const index of definition.indexes ?? []) {
    if (index.fields.length === 0) {
      throw new Error(`自定义模型 ${definition.kind} 的索引未声明任何字段`);
    }
    const seen = new Set<string>();
    for (const field of index.fields) {
      if (field.includes('.')) {
        throw new Error(`自定义模型 ${definition.kind} 的索引字段不支持嵌套路径：${field}`);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
        throw new Error(`自定义模型 ${definition.kind} 的索引字段名非法：${field}`);
      }
      if (seen.has(field)) {
        throw new Error(`自定义模型 ${definition.kind} 的索引字段重复：${field}`);
      }
      seen.add(field);
      const type = index.types[field];
      if (!type || !MODEL_FIELD_TYPES.has(type)) {
        throw new Error(
          `自定义模型 ${definition.kind} 的索引字段 ${field} 缺少显式类型（允许：string/integer/number/boolean）`,
        );
      }
    }
    for (const field of Object.keys(index.types)) {
      if (!seen.has(field)) {
        throw new Error(`自定义模型 ${definition.kind} 的索引类型声明了未列出的字段：${field}`);
      }
    }
  }
  const finalizers = definition.finalizers ?? [];
  if (new Set(finalizers).size !== finalizers.length) {
    throw new Error(`自定义模型 ${definition.kind} 的 finalizer 名称重复`);
  }
  return definition;
}

/** Default permission names derived from a model kind. */
export function customModelPermissions(kind: string): {
  read: string;
  write: string;
} {
  return {
    read: `custom.${kind}.read`,
    write: `custom.${kind}.write`,
  };
}
