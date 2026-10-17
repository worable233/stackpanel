/**
 * 兼容性门禁与完整部署计划求解（PLAN-github-distribution-and-updates §4）。
 *
 * 三条硬性要求：
 * - **依赖求解先在停服前完成**。每次更新先计算完整部署计划（内核 + builtin +
 *   可选插件 + 主题 + 依赖 + schema + ABI）；求解失败输出具体冲突，禁止默认停用
 *   用户插件来凑兼容。
 * - **版本号本身不代表兼容**：发布清单与探针共同决定。
 * - **跨版本跳升仅在存在可验证迁移路径时允许**；需要中间版本则生成有序计划。
 *   默认禁止自动降级。
 *
 * 本模块为纯函数，可在内核、updater 与测试中复用。
 */

import { type KernelManifest, type PackageManifest, type FrontendMode } from './manifest.js';
import { parseSemver, compareSemver, maxSatisfying, satisfiesRange } from './semver.js';
import type { PlannedPackage, PlanDigestInput } from './update-protocol.js';

/** 内核当前能力面（用于门禁判定）。 */
export interface KernelCapabilities {
  version: string;
  kernelApi: string;
  frontendAbi: string;
  /** 支持的包格式版本上界。 */
  packageFormat: number;
  /** 该内核支持的 schema 范围。 */
  schemaRange: string;
  /** 支持的前端加载模式。 */
  frontendModes: FrontendMode[];
  /** 支持平台，如 `linux/amd64`。 */
  platform: string;
}

/** 已安装组件（含用户状态）。 */
export interface InstalledComponent {
  kind: 'plugin' | 'theme';
  id: string;
  version: string;
  enabled: boolean;
  /** 管理员固定的版本（pin），求解必须遵守。 */
  pinnedVersion?: string;
  /** 是否被管理员排除自动更新。 */
  excluded?: boolean;
  /** 当前已授予的权限键。 */
  grantedPermissions: string[];
}

/** 候选来源：某组件可选的全部版本清单。 */
export interface CandidateSource {
  kind: 'plugin' | 'theme';
  id: string;
  /** 已按发布者信任链预过滤的合法清单。 */
  manifests: PackageManifest[];
}

export interface ResolveInput {
  kernel: KernelCapabilities;
  installed: InstalledComponent[];
  candidates: CandidateSource[];
  /** 目标内核（内核自身升级时）；缺省表示只解扩展。 */
  targetKernel?: Pick<
    KernelManifest,
    'version' | 'kernelApi' | 'frontendAbi' | 'schemaRange' | 'images'
  >;
  /** 允许该组件跨版本跳升的迁移路径判定。缺省视为不可跨版本。 */
  migrationPathFor?: (kind: 'plugin' | 'theme', id: string, from: string, to: string) => boolean;
}

export type ResolveResult =
  | { ok: true; plan: PlannedPackage[]; kernelVersion: string }
  | { ok: false; blocks: BlockReasonLike[] };

export interface BlockReasonLike {
  code:
    | 'policy'
    | 'incompatible_kernel'
    | 'incompatible_abi'
    | 'dependency_conflict'
    | 'permission_increase'
    | 'irreversible_migration'
    | 'downgrade';
  detail: string;
  /** 关联组件（若有）。 */
  component?: { kind: string; id: string };
}

/**
 * 门禁：一份包清单能否在当前内核上安装。返回阻止原因（空 = 通过）。
 * 这是市场安装与上传安装**共用**的校验。
 */
export function checkPackageCompatibility(
  manifest: PackageManifest,
  kernel: KernelCapabilities,
): BlockReasonLike[] {
  const blocks: BlockReasonLike[] = [];
  const component = { kind: manifest.kind, id: manifest.id };

  if (!satisfiesRange(kernel.version, manifest.compatibility.kernel)) {
    blocks.push({
      code: 'incompatible_kernel',
      detail: `需要内核 ${manifest.compatibility.kernel}，当前 ${kernel.version}`,
      component,
    });
  }
  if (!satisfiesRange(kernel.kernelApi, manifest.compatibility.kernelApi)) {
    blocks.push({
      code: 'incompatible_kernel',
      detail: `需要内核契约 ${manifest.compatibility.kernelApi}，当前 ${kernel.kernelApi}`,
      component,
    });
  }
  if (!satisfiesRange(kernel.frontendAbi, manifest.compatibility.frontendAbi)) {
    blocks.push({
      code: 'incompatible_abi',
      detail: `需要前端 ABI ${manifest.compatibility.frontendAbi}，当前 ${kernel.frontendAbi}`,
      component,
    });
  }
  if (manifest.compatibility.packageFormat > kernel.packageFormat) {
    blocks.push({
      code: 'incompatible_kernel',
      detail: `需要包格式 ${manifest.compatibility.packageFormat}，当前内核仅支持 ${kernel.packageFormat}`,
      component,
    });
  }
  // 前端加载模式必须被内核支持（不支持的平台明确不可安装）。
  const unsupported = manifest.frontendModes.filter((mode) => !kernel.frontendModes.includes(mode));
  if (unsupported.length > 0) {
    blocks.push({
      code: 'incompatible_abi',
      detail: `内核不支持前端模式 ${unsupported.join(', ')}`,
      component,
    });
  }
  return blocks;
}

/** 源仓库是否被发布者信任链允许（结构校验；实际信任判定见 trust.ts）。 */
export function sourceRepositoryAllowed(
  manifest: PackageManifest,
  allowed: readonly string[],
): boolean {
  return allowed.includes(manifest.source.repository);
}

/**
 * 权限增加判定（§4）：**按实际权限差异判断**，不能只信任发行者填写的
 * `automatic` 标记。返回新增的权限键。
 */
export function addedPermissions(from: string[], to: string[]): string[] {
  const existing = new Set(from);
  return to.filter((permission) => !existing.has(permission));
}

/**
 * 为单个组件选择目标版本（SemVer + 渠道 + pin，不用 `!==` 判升级）。
 * - pin 优先且必须严格可用。
 * - 默认升到「最高兼容 stable」，而非 GitHub latest。
 * - 默认禁止降级。
 */
export type TargetSelection =
  { ok: true; manifest: PackageManifest } | { ok: false; blocks: BlockReasonLike[] };

export function selectTargetVersion(
  source: CandidateSource,
  installed: InstalledComponent | undefined,
  kernel: KernelCapabilities,
  policy: { channel: 'stable' | 'beta'; allowDowngrade?: boolean; autoEligibleOnly?: boolean } = {
    channel: 'stable',
  },
): TargetSelection {
  const compatible = source.manifests.filter(
    (manifest) =>
      manifest.channel === policy.channel &&
      checkPackageCompatibility(manifest, kernel).length === 0 &&
      (!policy.autoEligibleOnly || manifest.automatic.eligible),
  );
  if (installed?.pinnedVersion) {
    const pinned = compatible.find((manifest) => manifest.version === installed.pinnedVersion);
    if (!pinned) {
      return {
        ok: false,
        blocks: [
          {
            code: 'policy',
            detail: `固定版本 ${installed.pinnedVersion} 不可用或与内核不兼容`,
            component: { kind: source.kind, id: source.id },
          },
        ],
      };
    }
    return { ok: true, manifest: pinned };
  }
  const best = maxSatisfying(
    compatible.map((manifest) => manifest.version),
    '*',
  );
  if (!best) {
    return {
      ok: false,
      blocks: [
        {
          code: 'incompatible_kernel',
          detail: `没有兼容的 ${policy.channel} 版本`,
          component: { kind: source.kind, id: source.id },
        },
      ],
    };
  }
  const manifest = compatible.find((candidate) => candidate.version === best);
  if (!manifest) {
    return {
      ok: false,
      blocks: [
        {
          code: 'incompatible_kernel',
          detail: '候选解析失败',
          component: { kind: source.kind, id: source.id },
        },
      ],
    };
  }
  return { ok: true, manifest };
}

/**
 * 求解完整部署计划（§4）。不修改任何用户插件状态；冲突显式输出。
 */
export function resolveDeployment(input: ResolveInput): ResolveResult {
  const blocks: BlockReasonLike[] = [];
  const { kernel, installed, candidates } = input;

  // 目标内核：若升级内核，兼容性必须以目标内核衡量。
  const targetKernel: KernelCapabilities = input.targetKernel
    ? {
        version: input.targetKernel.version,
        kernelApi: input.targetKernel.kernelApi,
        frontendAbi: input.targetKernel.frontendAbi,
        schemaRange: input.targetKernel.schemaRange,
        packageFormat: kernel.packageFormat,
        frontendModes: kernel.frontendModes,
        platform: kernel.platform,
      }
    : kernel;

  const installedByKey = new Map(installed.map((item) => [`${item.kind}/${item.id}`, item]));
  const plan: PlannedPackage[] = [];
  const plannedVersions = new Map<string, string>();

  for (const source of candidates) {
    const key = `${source.kind}/${source.id}`;
    const current = installedByKey.get(key);
    const selection = selectTargetVersion(source, current, targetKernel, { channel: 'stable' });
    if (!selection.ok) {
      // 没有任何兼容版本时才阻止；已安装且保持原样不算冲突。
      if (current) {
        const kept = source.manifests.find((m) => m.version === current.version);
        if (kept && checkPackageCompatibility(kept, targetKernel).length === 0) {
          continue;
        }
      }
      blocks.push(...selection.blocks);
      continue;
    }
    const manifest = selection.manifest;
    const fromVersion = current?.version ?? null;
    if (current && manifest.version === current.version) {
      plannedVersions.set(key, manifest.version);
      continue;
    }
    // 降级判定。
    if (current && fromVersion) {
      const cmp = compareTriples(manifest.version, fromVersion);
      if (cmp < 0) {
        const allowed = input.migrationPathFor?.(
          source.kind,
          source.id,
          fromVersion,
          manifest.version,
        );
        if (!allowed) {
          blocks.push({
            code: 'downgrade',
            detail: `${fromVersion} → ${manifest.version} 为降级，默认禁止`,
            component: { kind: source.kind, id: source.id },
          });
          continue;
        }
      } else if (cmp > 0) {
        const direct = input.migrationPathFor?.(
          source.kind,
          source.id,
          fromVersion,
          manifest.version,
        );
        // 升到更高 major，或跨多个 minor 时需要可验证迁移路径；同级或单步 minor/patch 放行。
        if (!direct && !withinAscendingStep(fromVersion, manifest.version)) {
          blocks.push({
            code: 'irreversible_migration',
            detail: `${fromVersion} → ${manifest.version} 缺可验证迁移路径`,
            component: { kind: source.kind, id: source.id },
          });
          continue;
        }
      }
    }
    const adds = addedPermissions(current?.grantedPermissions ?? [], manifest.permissions);
    plan.push({
      kind: source.kind,
      id: source.id,
      fromVersion,
      toVersion: manifest.version,
      revision: manifest.artifact.sha256,
      addsPermissions: adds.length > 0,
      reversible: manifest.migration.rollback === 'code-compatible',
    });
    plannedVersions.set(key, manifest.version);
  }

  // 依赖冲突：计划内组件的 requires 必须被 plan 或已安装组件满足。
  for (const source of candidates) {
    const key = `${source.kind}/${source.id}`;
    const targetVersion = plannedVersions.get(key);
    if (!targetVersion) continue;
    const manifest = source.manifests.find((m) => m.version === targetVersion);
    if (!manifest) continue;
    for (const requirement of manifest.requires) {
      if (requirement.optional) continue;
      if (requirement.kind === 'kernel') {
        if (!satisfiesRange(targetKernel.version, requirement.range ?? '*')) {
          blocks.push({
            code: 'dependency_conflict',
            detail: `${key} 需要内核 ${requirement.range ?? '*'}`,
            component: { kind: source.kind, id: source.id },
          });
        }
        continue;
      }
      const depKey = `${requirement.kind}/${requirement.id}`;
      const resolved = plannedVersions.get(depKey) ?? installedByKey.get(depKey)?.version;
      if (!resolved) {
        blocks.push({
          code: 'dependency_conflict',
          detail: `${key} 缺少依赖 ${depKey}`,
          component: { kind: source.kind, id: source.id },
        });
        continue;
      }
      if (requirement.range && !satisfiesRange(resolved, requirement.range)) {
        blocks.push({
          code: 'dependency_conflict',
          detail: `${key} 需要 ${depKey} ${requirement.range}，实际 ${resolved}`,
          component: { kind: source.kind, id: source.id },
        });
      }
    }
  }

  if (blocks.length > 0) return { ok: false, blocks };
  return { ok: true, plan, kernelVersion: targetKernel.version };
}

/** 构建计划摘要输入（顺序固定，保证可复现）。 */
export function buildPlanDigestInput(
  kernelVersion: string,
  frontendAbi: string,
  schemaRange: string,
  plan: PlannedPackage[],
): PlanDigestInput {
  const packages = [...plan]
    .map((item) => ({
      kind: item.kind,
      id: item.id,
      version: item.toVersion,
      revision: item.revision,
    }))
    .sort((a, b) =>
      `${a.kind}/${a.id}` < `${b.kind}/${b.id}`
        ? -1
        : `${a.kind}/${a.id}` > `${b.kind}/${b.id}`
          ? 1
          : 0,
    );
  return { kernelVersion, packages, frontendAbi, schemaRange };
}

/** 单个内核升级计划的求解结果。 */
export type KernelUpgradePlan =
  | { ok: true; target: KernelManifest; path: KernelManifest[]; digest: string }
  | { ok: false; blocks: BlockReasonLike[] };

export interface KernelUpgradeInput {
  /** 当前内核版本（产品版本）。 */
  currentVersion: string;
  /** 当前部署平台（如 `linux/amd64`）；缺省用第一个候选镜像。 */
  platform?: string;
  /** 可选的内核候选清单（已按发布者/信任链预过滤，且已剔除撤回）。 */
  candidates: KernelManifest[];
  /** 采纳渠道；只考虑该渠道的内核清单。 */
  channel: 'stable' | 'beta';
  /** 显式指定目标版本；缺省自动选最高可升级版本。 */
  targetVersion?: string;
  /** 允许降级的目标版本（显式请求时）；缺省禁止降级。 */
  allowDowngrade?: boolean;
}

/**
 * 求解内核自身升级（PLAN-github-distribution-and-updates §4、§13-4）。
 *
 * 与扩展求解对应：给定当前内核版本与签名目录中的内核清单，选出**目标内核**、校验
 * 平台镜像存在、并据 `migrationPath` 生成**有序中间版本**（跨版本跳升仅在存在可验证
 * 迁移路径时允许，否则阻止）。内核清单的签发/校验与包同一套信任链；本函数只做
 * 「选哪个版本、怎么走」，不接触网络与签名。
 */
export function resolveKernelUpgrade(input: KernelUpgradeInput): KernelUpgradePlan {
  const candidates = input.candidates
    .filter((manifest) => manifest.channel === input.channel)
    .filter((manifest) => manifest.kind === 'kernel');
  if (candidates.length === 0) {
    return {
      ok: false,
      blocks: [{ code: 'incompatible_kernel', detail: `没有可用的${input.channel}内核候选` }],
    };
  }

  const current = parseSemver(input.currentVersion);
  const pickForVersion = (version: string): KernelManifest | undefined =>
    candidates.find((manifest) => manifest.version === version);
  // 候选必须**自身声明**接受从当前版本升级（`upgradeFrom`），否则不得作为目标。
  const acceptsCurrent = (manifest: KernelManifest): boolean =>
    !current || satisfiesRange(input.currentVersion, manifest.upgradeFrom);

  let target: KernelManifest | undefined;
  if (input.targetVersion) {
    target = pickForVersion(input.targetVersion);
    if (!target) {
      return {
        ok: false,
        blocks: [
          {
            code: 'incompatible_kernel',
            detail: `指定的内核版本 ${input.targetVersion} 不在候选目录中`,
          },
        ],
      };
    }
    if (!acceptsCurrent(target)) {
      return {
        ok: false,
        blocks: [
          {
            code: 'incompatible_kernel',
            detail: `目标内核 ${target.version} 声明不接受来自 ${input.currentVersion} 的升级（upgradeFrom ${target.upgradeFrom}）`,
          },
        ],
      };
    }
    const targetSemver = parseSemver(target.version);
    if (
      current &&
      targetSemver &&
      compareSemver(targetSemver, current) < 0 &&
      !input.allowDowngrade
    ) {
      return {
        ok: false,
        blocks: [
          {
            code: 'downgrade',
            detail: `${input.currentVersion} → ${target.version} 为降级，默认禁止`,
          },
        ],
      };
    }
  } else {
    const upgrades = candidates.filter((manifest) => {
      const version = parseSemver(manifest.version);
      if (!version || !current) return false;
      if (compareSemver(version, current) <= 0) return false;
      if (!acceptsCurrent(manifest)) return false;
      return true;
    });
    const best = maxSatisfying(
      upgrades.map((manifest) => manifest.version),
      '*',
    );
    target = best ? pickForVersion(best) : undefined;
  }

  if (!target) {
    return { ok: false, blocks: [{ code: 'incompatible_kernel', detail: '没有可升级的内核版本' }] };
  }

  // 平台镜像必须存在（以 digest 安装，禁止依赖 latest）。
  const platform = input.platform ?? target.images[0]?.platform;
  const image = platform
    ? target.images.find((candidate) => candidate.platform === platform)
    : undefined;
  if (!image || !image.digest) {
    return {
      ok: false,
      blocks: [
        {
          code: 'incompatible_kernel',
          detail: `目标内核 ${target.version} 没有平台 ${platform ?? '（未知）'} 的镜像 digest`,
        },
      ],
    };
  }
  if (target.updateProtocol > UPDATE_PROTOCOL_MAX) {
    return {
      ok: false,
      blocks: [
        {
          code: 'incompatible_kernel',
          detail: `目标内核要求升级协议 ${target.updateProtocol}，当前执行器最高支持 ${UPDATE_PROTOCOL_MAX}`,
        },
      ],
    };
  }

  // 迁移路径：direct 或有序中间版本链。跨版本时逐步校验每一步都在候选中。
  const path = resolveKernelPath(target, pickForVersion);
  if (!path.ok) return path;

  return { ok: true, target, path: path.path, digest: image.digest };
}

/** 当前内核/执行器支持的升级协议上界（单一来源，见 update-protocol）。 */
export const UPDATE_PROTOCOL_MAX = 1;

function resolveKernelPath(
  target: KernelManifest,
  pick: (version: string) => KernelManifest | undefined,
): { ok: true; path: KernelManifest[] } | { ok: false; blocks: BlockReasonLike[] } {
  if (target.migrationPath === 'direct') {
    return { ok: true, path: [target] };
  }
  const path: KernelManifest[] = [];
  for (const version of target.migrationPath) {
    const step = version === target.version ? target : pick(version);
    if (!step) {
      return {
        ok: false,
        blocks: [
          {
            code: 'irreversible_migration',
            detail: `迁移路径缺少中间版本 ${version}`,
          },
        ],
      };
    }
    path.push(step);
  }
  if (path.length === 0) {
    return {
      ok: false,
      blocks: [{ code: 'irreversible_migration', detail: '迁移路径为空，缺可验证路径' }],
    };
  }
  return { ok: true, path };
}

// —— 内部：版本比较（复用 semver 契约，无循环依赖） ——

function parseTriple(version: string): [number, number, number] {
  const parsed = parseSemver(version);
  return parsed ? [parsed.major, parsed.minor, parsed.patch] : [0, 0, 0];
}

function compareTriples(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  return compareSemver(left, right);
}

function withinAscendingStep(a: string, b: string): boolean {
  const from = parseTriple(a);
  const to = parseTriple(b);
  // 同 major 且只升一个 minor（或同 minor 的 patch）视为可直接升级；跨 major /
  // 跨多个 minor 需要调用方声明迁移路径。
  return to[0] === from[0] && to[1] <= from[1] + 1;
}
