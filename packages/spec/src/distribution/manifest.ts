/**
 * 分发清单与目录契约（PLAN-github-distribution-and-updates §3）。
 *
 * 这是「发布端构建、实例自动发现/下载/校验/安装」全链路的**机器可读契约单一
 * 来源**。内核 `apps/api/src/distribution/**`、发布脚本 `scripts/release/**` 与测试
 * 都从这里取类型与校验，避免版本声明、摘要字段、兼容范围三处漂移。
 *
 * 设计约束（对齐主计划 §3.1）：
 * - 组件主键 `(kind, id)`；版本 SemVer；revision 是完整 SHA-256 **内容摘要**，
 *   与版本号不可混用。
 * - 版本声明分五个独立维度：`kernel`（产品版本）/ `kernelApi`（契约版本）/
 *   `frontendAbi` / 升级协议 `updateProtocol` / DB `schemaRange`。禁止互相替代。
 * - URL 只作**展示信息**，不能触发执行（`releaseNotes`）。
 *
 * 本模块零运行时依赖（除 `node:crypto` 用于 revision），可在内核、契约脚本、CI
 * 与发布工具中复用。
 */

/** 组件类别。内核是特殊一类，独立清单形状。 */
export type ComponentKind = 'plugin' | 'theme';

/** 发布渠道。 */
export type ReleaseChannel = 'stable' | 'beta';

/** 前端加载模式（对齐 runtime-frontend-contracts/01）。 */
export type FrontendMode = 'M1' | 'M2';

/** 包格式版本；增加不兼容清单字段时递增。 */
export const PACKAGE_MANIFEST_FORMAT_VERSION = 1;
/** 目录格式版本。 */
export const CATALOG_FORMAT_VERSION = 1;

/** 包体来源引用。目录只引用，不保存安装包（主计划 §2）。 */
export interface PackageSource {
  /** 允许的发布仓库，如 `worable233/stackpanel-plugins`。 */
  repository: string;
  /** Release tag，如 `plugin-llm-gateway-v1.2.3`。 */
  tag: string;
  /** 资产文件名，如 `llm-gateway-1.2.3.zip`。 */
  asset: string;
}

/** 产物摘要与大小。安装前必须校验，记录实际安装的 digest 而非只记版本名。 */
export interface PackageArtifact {
  /** 64 位小写十六进制 SHA-256。 */
  sha256: string;
  /** 字节数。 */
  size: number;
}

/** 兼容性声明（五维独立）。 */
export interface PackageCompatibility {
  /** 内核产品版本范围，如 `>=0.2.0 <0.3.0`。 */
  kernel: string;
  /** 内核契约 API 版本范围（对应 `KERNEL_API_VERSION`）。 */
  kernelApi: string;
  /** 前端 ABI 版本范围（对齐契约 02 的宿主 ABI 槽版本）。 */
  frontendAbi: string;
  /** 包格式版本，整数；内核只接受 ≤ 自身支持的版本。 */
  packageFormat: number;
}

/** 数据迁移声明（主计划 §3.2 / §7.4）。 */
export interface PackageMigration {
  /** `none` = 无迁移；`supported` = 走受支持迁移协议。 */
  mode: 'none' | 'supported';
  /** 回退语义：`code-compatible` = 新旧代码都读同一 schema；`snapshot` = 需快照恢复。 */
  rollback: 'code-compatible' | 'snapshot';
}

/** 自动更新资格（目录的**宣称**，不等于实例已授权，见主计划 §4）。 */
export interface PackageAutomatic {
  eligible: boolean;
}

/**
 * 统一包清单（插件 / 主题共用；内核清单形状不同，见 {@link KernelManifest}）。
 *
 * 字段示意与主计划 §3.2 JSON 一一对应。
 */
export interface PackageManifest {
  formatVersion: number;
  kind: ComponentKind;
  id: string;
  version: string;
  channel: ReleaseChannel;
  source: PackageSource;
  artifact: PackageArtifact;
  compatibility: PackageCompatibility;
  /** 依赖的 `(kind,id)` 及可选版本范围。 */
  requires: PackageDependency[];
  /** 冲突组件 `(kind,id)`。 */
  conflicts: PackageConflict[];
  /** 申请的权限键（权限增加不自动执行，见主计划 §4）。 */
  permissions: string[];
  frontendModes: FrontendMode[];
  migration: PackageMigration;
  automatic: PackageAutomatic;
  /** 展示用 Release 页面；**不**触发脚本执行。 */
  releaseNotes?: string;
  /** 发布者身份（目录绑定，见信任链）。 */
  publisher?: string;
  /** 人类可读名称/描述（展示用）。 */
  name?: string;
  description?: string;
}

export interface PackageDependency {
  kind: 'kernel' | 'plugin' | 'theme';
  id: string;
  /** 可选 SemVer 范围；缺省表示任意兼容版本。 */
  range?: string;
  optional?: boolean;
}

export interface PackageConflict {
  kind: ComponentKind;
  id: string;
}

/** 多架构镜像摘要（内核清单）。 */
export interface KernelImageDigest {
  /** `linux/amd64` / `linux/arm64`。 */
  platform: string;
  /** 完整 `ghcr.io/...@sha256:...` 引用。 */
  digest: string;
}

/**
 * 内核升级载体（ADR-0025）。`oci` 走镜像，`artifact` 走自包含产物包。
 * 两种载体在清单中并列声明，安装与升级语义一致，仅执行原语不同。
 */
export type KernelCarrier = 'oci' | 'artifact';

/** 产物包用途：运行内核，或仅在升级窗口内使用的迁移工具。 */
export type ArtifactRole = 'kernel' | 'migrate';

/**
 * 自包含构建产物（ADR-0025 决策 2）。
 *
 * 与 {@link KernelImageDigest} 的关键区别：`sha256` 是 tarball 的裸摘要，
 * **不是** `repo@sha256:...` 完整引用。历史实现曾把完整引用当摘要拼接，
 * 产出 `sha256:repo@sha256:...`，因此契约层直接禁止该形态。
 */
export interface KernelArtifact {
  /** 产物用途。`migrate` 包只在升级窗口内下载，运行包不携带 Prisma CLI。 */
  role: ArtifactRole;
  /** `linux/amd64` / `linux/arm64`。 */
  platform: string;
  /** 下载地址；发布时通常指向 GitHub Release asset。 */
  url: string;
  /** tarball 的 SHA-256，裸 64 位小写 hex。 */
  sha256: string;
  /** tarball 字节数。 */
  size: number;
  /** 目标 Node 主版本；与产物内原生依赖的 ABI 绑定。 */
  nodeMajor: number;
}

/** 内核版本清单（主计划 §3.2 末段）。 */
export interface KernelManifest {
  formatVersion: number;
  kind: 'kernel';
  /** 内核产品版本 `X.Y.Z`。 */
  version: string;
  channel: ReleaseChannel;
  /** 内核契约 API 版本。 */
  kernelApi: string;
  /** 前端 ABI 版本。 */
  frontendAbi: string;
  /** 升级协议版本。 */
  updateProtocol: number;
  /** 允许自动升级的来源版本范围。 */
  upgradeFrom: string;
  /** 迁移路径：有序的中间版本，或用 `direct` 表示可直接跳升。 */
  migrationPath: 'direct' | string[];
  /** 旧版本仍可运行的 schema 范围（回退窗口判定）。 */
  schemaRange: string;
  /** 多架构镜像摘要；以 digest 安装，禁止依赖 latest。 */
  images: KernelImageDigest[];
  /**
   * 自包含产物包（ADR-0025）。与 `images` 并列，至少其一非空。
   * 非 Docker 部署只消费 `artifacts`。
   */
  artifacts?: KernelArtifact[];
  /** builtin 核心包兼容集合（随内核发布，不独立漂移）。 */
  corePackages: PackageDependency[];
  /** 受支持平台（Node / OS）。 */
  supportedPlatforms: string[];
  /** 冒烟探针版本。 */
  smokeProbeVersion: number;
  /** 该版本内 DB 迁移版本（`_prisma_migrations` 最新名）。 */
  databaseMigration: string;
  releaseNotes?: string;
}

/** 校验错误。`path` 用点分定位，便于测试与日志。 */
export interface ContractIssue {
  path: string;
  message: string;
}

const ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FULL_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  issues: ContractIssue[],
  value: unknown,
  path: string,
  { pattern, minLength = 1 }: { pattern?: RegExp; minLength?: number } = {},
): void {
  if (typeof value !== 'string' || value.length < minLength) {
    issues.push({ path, message: '必须是非空字符串' });
    return;
  }
  if (pattern && !pattern.test(value)) {
    issues.push({ path, message: `格式不匹配：${value}` });
  }
}

/**
 * 校验统一包清单。返回全部问题（空数组 = 通过）。调用方决定是拒装还是告警。
 * 版本与范围语法由 {@link ./semver} 判定，避免两套规则。
 */
export function validatePackageManifest(input: unknown): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!isPlainObject(input)) return [{ path: '', message: '清单必须是对象' }];
  const manifest = input as Record<string, unknown>;

  if (manifest.formatVersion !== PACKAGE_MANIFEST_FORMAT_VERSION) {
    issues.push({
      path: 'formatVersion',
      message: `必须是 ${PACKAGE_MANIFEST_FORMAT_VERSION}`,
    });
  }
  if (manifest.kind !== 'plugin' && manifest.kind !== 'theme') {
    issues.push({ path: 'kind', message: '必须是 plugin 或 theme' });
  }
  requireString(issues, manifest.id, 'id', { pattern: ID_PATTERN });
  requireString(issues, manifest.version, 'version', { pattern: FULL_SEMVER_PATTERN });
  if (manifest.channel !== 'stable' && manifest.channel !== 'beta') {
    issues.push({ path: 'channel', message: '必须是 stable 或 beta' });
  }
  if (manifest.name !== undefined) requireString(issues, manifest.name, 'name');
  if (manifest.description !== undefined)
    requireString(issues, manifest.description, 'description');
  if (manifest.publisher !== undefined) requireString(issues, manifest.publisher, 'publisher');
  if (manifest.releaseNotes !== undefined)
    requireString(issues, manifest.releaseNotes, 'releaseNotes');

  issues.push(...validateSource(manifest.source));
  issues.push(...validateArtifact(manifest.artifact));
  issues.push(...validateCompatibility(manifest.compatibility));
  issues.push(...validateRequires(manifest.requires));
  issues.push(...validateConflicts(manifest.conflicts));
  issues.push(...validateStringArray(manifest.permissions, 'permissions'));
  issues.push(...validateFrontendModes(manifest.frontendModes));
  issues.push(...validateMigration(manifest.migration));
  issues.push(...validateAutomatic(manifest.automatic));
  return issues;
}

function validateSource(source: unknown): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!isPlainObject(source)) return [{ path: 'source', message: '必须是对象' }];
  requireString(issues, source.repository, 'source.repository', { pattern: REPOSITORY_PATTERN });
  requireString(issues, source.tag, 'source.tag');
  requireString(issues, source.asset, 'source.asset');
  if (
    typeof source.asset === 'string' &&
    (source.asset.includes('/') || source.asset.includes('..'))
  ) {
    issues.push({ path: 'source.asset', message: '资产名不得包含路径分隔符' });
  }
  return issues;
}

function validateArtifact(artifact: unknown): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!isPlainObject(artifact)) return [{ path: 'artifact', message: '必须是对象' }];
  requireString(issues, artifact.sha256, 'artifact.sha256', { pattern: SHA256_PATTERN });
  if (typeof artifact.size !== 'number' || !Number.isInteger(artifact.size) || artifact.size < 0) {
    issues.push({ path: 'artifact.size', message: '必须是非负整数' });
  }
  return issues;
}

function validateCompatibility(compatibility: unknown): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!isPlainObject(compatibility)) return [{ path: 'compatibility', message: '必须是对象' }];
  requireString(issues, compatibility.kernel, 'compatibility.kernel');
  requireString(issues, compatibility.kernelApi, 'compatibility.kernelApi');
  requireString(issues, compatibility.frontendAbi, 'compatibility.frontendAbi');
  if (
    typeof compatibility.packageFormat !== 'number' ||
    !Number.isInteger(compatibility.packageFormat) ||
    compatibility.packageFormat < 1
  ) {
    issues.push({ path: 'compatibility.packageFormat', message: '必须是 ≥1 的整数' });
  }
  return issues;
}

function validateKernelArtifacts(artifacts: unknown): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (artifacts === undefined) return issues;
  if (!Array.isArray(artifacts)) return [{ path: 'artifacts', message: '必须是数组' }];

  const seen = new Set<string>();
  artifacts.forEach((entry, index) => {
    const path = `artifacts[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push({ path, message: '必须是对象' });
      return;
    }
    if (entry.role !== 'kernel' && entry.role !== 'migrate') {
      issues.push({ path: `${path}.role`, message: '必须是 kernel 或 migrate' });
    }
    if (typeof entry.platform !== 'string' || !PLATFORM_PATTERN.test(entry.platform)) {
      issues.push({ path: `${path}.platform`, message: '必须是 linux|darwin / amd64|arm64' });
    }
    requireString(issues, entry.url, `${path}.url`, { pattern: HTTP_URL_PATTERN });
    // 裸摘要：不接受 `sha256:` 前缀，更不接受完整 `repo@sha256:...` 引用。
    requireString(issues, entry.sha256, `${path}.sha256`, { pattern: SHA256_PATTERN });
    if (
      typeof entry.size !== 'number' ||
      !Number.isInteger(entry.size) ||
      entry.size <= 0
    ) {
      issues.push({ path: `${path}.size`, message: '必须是正整数' });
    }
    if (
      typeof entry.nodeMajor !== 'number' ||
      !Number.isInteger(entry.nodeMajor) ||
      entry.nodeMajor < 18
    ) {
      issues.push({ path: `${path}.nodeMajor`, message: '必须是 ≥18 的整数' });
    }

    // (role, platform) 必须唯一：同一平台不允许出现两个内核包或两个迁移包。
    if (typeof entry.role === 'string' && typeof entry.platform === 'string') {
      const key = `${entry.role}@${entry.platform}`;
      if (seen.has(key)) {
        issues.push({ path, message: `重复的 role+platform：${key}` });
      }
      seen.add(key);
    }
  });

  // 每个声明了的平台，必须同时具备 kernel 与 migrate 包——否则升级到一半才发现无法迁移。
  const byRole = { kernel: new Set<string>(), migrate: new Set<string>() };
  for (const entry of artifacts) {
    if (!isPlainObject(entry)) continue;
    const role = entry.role;
    const platform = entry.platform;
    if ((role === 'kernel' || role === 'migrate') && typeof platform === 'string') {
      byRole[role].add(platform);
    }
  }
  for (const platform of byRole.kernel) {
    if (!byRole.migrate.has(platform)) {
      issues.push({
        path: 'artifacts',
        message: `平台 ${platform} 缺少 migrate 产物包`,
      });
    }
  }
  for (const platform of byRole.migrate) {
    if (!byRole.kernel.has(platform)) {
      issues.push({
        path: 'artifacts',
        message: `平台 ${platform} 只有 migrate 产物包，缺少 kernel 产物包`,
      });
    }
  }

  return issues;
}

function validateRequires(requires: unknown): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (requires === undefined) return issues;
  if (!Array.isArray(requires)) return [{ path: 'requires', message: '必须是数组' }];
  requires.forEach((entry, index) => {
    const path = `requires[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push({ path, message: '必须是对象' });
      return;
    }
    if (entry.kind !== 'kernel' && entry.kind !== 'plugin' && entry.kind !== 'theme') {
      issues.push({ path: `${path}.kind`, message: '必须是 kernel/plugin/theme' });
    }
    requireString(issues, entry.id, `${path}.id`, { pattern: ID_PATTERN });
    if (entry.range !== undefined) requireString(issues, entry.range, `${path}.range`);
    if (entry.optional !== undefined && typeof entry.optional !== 'boolean') {
      issues.push({ path: `${path}.optional`, message: '必须是布尔值' });
    }
  });
  return issues;
}

function validateConflicts(conflicts: unknown): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (conflicts === undefined) return issues;
  if (!Array.isArray(conflicts)) return [{ path: 'conflicts', message: '必须是数组' }];
  conflicts.forEach((entry, index) => {
    const path = `conflicts[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push({ path, message: '必须是对象' });
      return;
    }
    if (entry.kind !== 'plugin' && entry.kind !== 'theme') {
      issues.push({ path: `${path}.kind`, message: '必须是 plugin 或 theme' });
    }
    requireString(issues, entry.id, `${path}.id`, { pattern: ID_PATTERN });
  });
  return issues;
}

function validateStringArray(value: unknown, path: string): ContractIssue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [{ path, message: '必须是数组' }];
  const issues: ContractIssue[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      issues.push({ path: `${path}[${index}]`, message: '必须是非空字符串' });
      return;
    }
    if (seen.has(entry)) {
      issues.push({ path: `${path}[${index}]`, message: `重复项：${entry}` });
    }
    seen.add(entry);
  });
  return issues;
}

function validateFrontendModes(modes: unknown): ContractIssue[] {
  if (!Array.isArray(modes)) return [{ path: 'frontendModes', message: '必须是数组' }];
  const issues: ContractIssue[] = [];
  for (const [index, mode] of modes.entries()) {
    if (mode !== 'M1' && mode !== 'M2') {
      issues.push({ path: `frontendModes[${index}]`, message: '必须是 M1 或 M2' });
    }
  }
  return issues;
}

function validateMigration(migration: unknown): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!isPlainObject(migration)) return [{ path: 'migration', message: '必须是对象' }];
  if (migration.mode !== 'none' && migration.mode !== 'supported') {
    issues.push({ path: 'migration.mode', message: '必须是 none 或 supported' });
  }
  if (migration.rollback !== 'code-compatible' && migration.rollback !== 'snapshot') {
    issues.push({ path: 'migration.rollback', message: '必须是 code-compatible 或 snapshot' });
  }
  return issues;
}

function validateAutomatic(automatic: unknown): ContractIssue[] {
  if (!isPlainObject(automatic)) return [{ path: 'automatic', message: '必须是对象' }];
  if (typeof automatic.eligible !== 'boolean') {
    return [{ path: 'automatic.eligible', message: '必须是布尔值' }];
  }
  return [];
}

const PLATFORM_PATTERN = /^(linux|darwin|win32)\/(amd64|arm64)$/;
const DIGEST_REF_PATTERN = /^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/;
/** 产物下载地址：必须显式 https，拒绝把任意 URL 当指令来源。 */
const HTTP_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/\S+$/;

/** 校验内核版本清单。 */
export function validateKernelManifest(input: unknown): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!isPlainObject(input)) return [{ path: '', message: '清单必须是对象' }];
  const manifest = input as Record<string, unknown>;

  if (manifest.formatVersion !== PACKAGE_MANIFEST_FORMAT_VERSION) {
    issues.push({ path: 'formatVersion', message: `必须是 ${PACKAGE_MANIFEST_FORMAT_VERSION}` });
  }
  if (manifest.kind !== 'kernel') issues.push({ path: 'kind', message: '必须是 kernel' });
  requireString(issues, manifest.version, 'version', { pattern: FULL_SEMVER_PATTERN });
  if (manifest.channel !== 'stable' && manifest.channel !== 'beta') {
    issues.push({ path: 'channel', message: '必须是 stable 或 beta' });
  }
  requireString(issues, manifest.kernelApi, 'kernelApi');
  requireString(issues, manifest.frontendAbi, 'frontendAbi');
  if (
    typeof manifest.updateProtocol !== 'number' ||
    !Number.isInteger(manifest.updateProtocol) ||
    manifest.updateProtocol < 1
  ) {
    issues.push({ path: 'updateProtocol', message: '必须是 ≥1 的整数' });
  }
  requireString(issues, manifest.upgradeFrom, 'upgradeFrom');
  if (manifest.migrationPath !== 'direct') {
    if (
      !Array.isArray(manifest.migrationPath) ||
      manifest.migrationPath.some((v) => typeof v !== 'string')
    ) {
      issues.push({ path: 'migrationPath', message: "必须是 'direct' 或版本字符串数组" });
    }
  }
  requireString(issues, manifest.schemaRange, 'schemaRange');

  // ADR-0025：至少一种升级载体。空数组与缺省都视为"未声明"。
  const hasImages = Array.isArray(manifest.images) && manifest.images.length > 0;
  const hasArtifacts = Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0;
  if (!hasImages && !hasArtifacts) {
    issues.push({ path: 'images', message: '必须声明至少一种升级载体（images 或 artifacts）' });
  }

  if (manifest.images !== undefined && !Array.isArray(manifest.images)) {
    issues.push({ path: 'images', message: '必须是数组' });
  } else if (Array.isArray(manifest.images)) {
    manifest.images.forEach((image, index) => {
      const path = `images[${index}]`;
      if (!isPlainObject(image)) {
        issues.push({ path, message: '必须是对象' });
        return;
      }
      if (typeof image.platform !== 'string' || !PLATFORM_PATTERN.test(image.platform)) {
        issues.push({ path: `${path}.platform`, message: '必须是 linux|darwin / amd64|arm64' });
      }
      if (typeof image.digest !== 'string' || !DIGEST_REF_PATTERN.test(image.digest)) {
        issues.push({ path: `${path}.digest`, message: '必须是完整 @sha256 引用' });
      }
    });
  }

  issues.push(...validateKernelArtifacts(manifest.artifacts));

  issues.push(...validateRequires(manifest.corePackages));
  issues.push(...validateStringArray(manifest.supportedPlatforms, 'supportedPlatforms'));
  if (
    typeof manifest.smokeProbeVersion !== 'number' ||
    !Number.isInteger(manifest.smokeProbeVersion) ||
    manifest.smokeProbeVersion < 1
  ) {
    issues.push({ path: 'smokeProbeVersion', message: '必须是 ≥1 的整数' });
  }
  requireString(issues, manifest.databaseMigration, 'databaseMigration');
  if (manifest.releaseNotes !== undefined)
    requireString(issues, manifest.releaseNotes, 'releaseNotes');
  return issues;
}

/** 便捷判定：清单是否有任何问题。 */
export function isValidPackageManifest(input: unknown): input is PackageManifest {
  return validatePackageManifest(input).length === 0;
}

/** 便捷判定：内核清单是否有任何问题。 */
export function isValidKernelManifest(input: unknown): input is KernelManifest {
  return validateKernelManifest(input).length === 0;
}
