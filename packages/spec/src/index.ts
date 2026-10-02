/**
 * `@stackpanel/spec` —— StackPanel 协议契约的单一来源（SPEC-SDK / D13/D15）。
 *
 * 导出三类契约原语：
 * - 版本：`KERNEL_VERSION`（内核产品版本）/ `KERNEL_API_VERSION`（契约版本）/
 *   `API_VERSION` / `OPEN_API_NAMESPACE` / `kernelApiVersionRange`（内核与 SDK
 *   包共享，发版联动）。
 * - OpenAPI 投影：能力项 → 文档 operation（内核 docs 与快照共用）。
 * - 兼容性：`normalizeSpec` / `buildSnapshot` / `diffContracts`（CI 破坏性变更门禁）。
 *
 * 本包不依赖任何运行时依赖，可在内核、契约脚本、CI 与第三方工具中复用。
 */
export * from './version.js';
export * from './contract.js';
export * from './openapi.js';
