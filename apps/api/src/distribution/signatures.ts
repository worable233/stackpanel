/**
 * 分发签名校验（PLAN-github-distribution-and-updates §3.3）。
 *
 * 实现已上移为契约单一来源 `@stackpanel/spec` 的 `distribution/signing.ts`：发布端与
 * 实例端共用**同一** Ed25519 载荷与摘要算法，避免「怎么签」与「怎么验」两处漂移。
 * 本文件只做内核侧命名桥接，不再自带实现。
 */

export {
  catalogDigest,
  DistributionSignatureError,
  packageFileDigests as packageFileHashes,
  parsePackageSignatureFile,
  verifyCatalogSignatureBytes as verifyCatalogSignature,
  verifyPackageSignatureBound,
  type PackageSignatureFile,
} from '@stackpanel/spec';
