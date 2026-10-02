/**
 * OpenAPI 契约快照 + 兼容性判定（CONTRACT-SEC / G2；SPEC-SDK / D15 起归属
 * `@stackpanel/spec`）。
 *
 * 契约的**单一来源**已抽到 `@stackpanel/spec`（无依赖，供内核、契约脚本、CI 与
 * 第三方工具复用）。本文件保留内核侧历史导入路径；实现全部转出。
 */
export {
  buildSnapshot,
  diffContracts,
  hashOperations,
  normalizeSpec,
  scopeOperations,
  snapshotFromOperations,
  toOpenApiPath,
} from '@stackpanel/spec';
export type {
  ContractBreak,
  ContractDiff,
  ContractOperation,
  ContractSnapshot,
} from '@stackpanel/spec';
