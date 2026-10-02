/**
 * 开放平台契约投影（CONTRACT-SEC / G2；SPEC-SDK / D15 起归属 `@stackpanel/spec`）。
 *
 * 契约的**单一来源**已抽到 `@stackpanel/spec`，内核、契约快照脚本与第三方工具
 * 共用同一实现。本文件仅保留内核侧的历史入口与 `Capability → OpenApiCapability`
 * 适配（内核能力项类型无法进入无依赖的契约包）。
 */
import type { Capability } from './capability-registry.ts';
import type { OpenApiCapability } from '@stackpanel/spec';

export {
  applyCapabilityOperations,
  capabilityPaths,
  toOpenApiOperation,
  toOpenApiPath,
} from '@stackpanel/spec';
export type { OpenApiCapability, OpenApiOperation } from '@stackpanel/spec';

/** 把一个内核 {@link Capability} 映射为契约投影输入。 */
export function fromKernelCapability(capability: Capability): OpenApiCapability {
  return {
    method: capability.method,
    path: capability.path,
    summary: capability.summary,
    scope: capability.scope,
    mutating: capability.mutating,
  };
}
