/**
 * 内核分发模块出口（PLAN-github-distribution-and-updates §11）。
 *
 * 契约类型与纯函数来自单一来源 `@stackpanel/spec`；这里只导出**内核侧实现**
 * （GitHub 源与缓存、目录客户端、包下载校验、信任根加载）。
 */

export * from './github-source.ts';
export * from './catalog-client.ts';
export * from './package-source.ts';
export * from './keyring.ts';
export {
  DistributionSignatureError,
  catalogDigest,
  parsePackageSignatureFile,
  verifyCatalogSignature,
  verifyPackageSignatureBound,
} from './signatures.ts';
