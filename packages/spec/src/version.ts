/**
 * 内核 API 版本的**唯一来源**（SPEC-SDK / D13）。
 *
 * `KERNEL_API_VERSION` 是插件 `manifest.apiVersion` 必须命中的兼容范围基准：
 * 内核用 `semver.satisfies(KERNEL_API_VERSION, manifest.apiVersion)` 校验，打包
 * 脚本注入 `apiVersion: ">=<KERNEL_API_VERSION>"`。此前该值硬编码在
 * `apps/api/src/lib/plugins.ts`，与 SDK / 契约包版本没有单一出处，插件生态无法
 * 对一个稳定号承诺。现在内核、SDK 与契约包共享本模块。
 *
 * 版本语义（语义化版本）：
 * - 破坏性变更（删除 / 改语义）→ 提 major。
 * - 向后兼容新增（新能力项、新可选字段）→ 提 minor。
 * - 文案 / 文档级修正 → 提 patch。
 *
 * 发版联动：`.github/workflows/publish-packages.yml` 在 `sdk-v*` 标签时以本值校验
 * SDK / spec / mcp 包 `version`，避免「内核契约版本」与「已发布 SDK 版本」漂移。
 *
 * 注意区分**契约版本** {@link KERNEL_API_VERSION} 与**产品版本**
 * {@link KERNEL_VERSION}：前者管插件兼容，后者管内核 `vX.Y.Z` 发版。
 */

/** 内核契约 API 版本；插件 `manifest.apiVersion` 据此校验。 */
export const KERNEL_API_VERSION = '0.4.0';

/**
 * 内核产品版本（镜像 `vX.Y.Z` 标签与运行时暴露的版本号）。
 *
 * 与 {@link KERNEL_API_VERSION} 是**两个独立概念**：后者是插件 / 开放生态的
 * **契约版本**（决定 `manifest.apiVersion` 兼容范围），前者是内核**产品版本**
 * （决定 `vX.Y.Z` 标签与镜像版本）。产品可以在契约版本不变时独立发版。
 *
 * 唯一来源：内核各包 `package.json` 的 `version`（root、`apps/*`、内部
 * `packages/{db,ui,net-guard}`）必须与本值一致，由
 * `packages/spec/tests/spec.test.ts` 钉死。
 */
export const KERNEL_VERSION = '0.1.0';

/** 人类可读的开放平台版本，用于文档与响应头。 */
export const API_VERSION = 'v1';

/** 对外承诺的稳定开放平台命名空间。 */
export const OPEN_API_NAMESPACE = '/api/v1';

/** 打包时注入的 `apiVersion` 下限（与 {@link KERNEL_API_VERSION} 同源）。 */
export function kernelApiVersionRange(): string {
  return `>=${KERNEL_API_VERSION}`;
}
