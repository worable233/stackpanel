/**
 * 分发契约模块（PLAN-github-distribution-and-updates §3、§4、§5、§7）。
 *
 * 单一来源，零运行时依赖（除 `node:crypto`），供：
 * - 内核 `apps/api/src/distribution/**`、`packages/**`、`updates/**`
 * - 独立 `apps/updater/**`
 * - 发布脚本 `scripts/release/**` 与 CI
 * - 契约测试
 *
 * 覆盖：包/内核清单、市场目录与回放保护、revision 内容摘要、升级协议与状态机、
 * 信任链与 keyring、统一安装事务与失败兜底、兼容性门禁与部署计划求解。
 */

export * from './semver.js';
export * from './manifest.js';
export * from './catalog.js';
export * from './signing.js';
export * from './revision.js';
export * from './update-protocol.js';
export * from './update-channel.js';
export * from './trust.js';
export * from './install.js';
export * from './compatibility.js';
