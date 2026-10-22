/**
 * 分发源配置（PLAN-github-distribution-and-updates §2、§10）。
 *
 * 目录仓、渠道、分支、加速地址过去只能通过环境变量配置——运维要改一次就得改
 * `.env` 并重启。这里把它们收敛成**可持久化的配置**：数据库有值时以数据库为准，
 * 没有时回退到环境变量（含内核自带的默认源）。
 *
 * 为什么仍保留环境变量：容器/集群部署常把配置写死在 Compose/Helm 里，那是最稳的
 * 兜底；后台只是把「日常调整」变成不需要重启的操作。
 *
 * 三个键分工明确：
 * - `distribution.catalogSource`（Setting，非敏感）：仓库、渠道、分支、加速地址。
 * - `distribution.catalogPublicKey`（Setting，公开信息）：目录验签公钥。
 * - `distribution.catalogToken`（Secret，加密）：私有目录的只读 token。
 *
 * token 单独走加密存储，且**只发给 GitHub 主机**——加速前缀是第三方，绝不转发。
 */

import type { Prisma } from '@stackpanel/db';
import {
  env,
  normalizeCatalogRepository,
  DEFAULT_CATALOG_KEY_ID,
  DEFAULT_CATALOG_PUBLIC_KEY,
  DEFAULT_CATALOG_REPOSITORY,
} from '../config/env.ts';
import { normalizeMirror } from './github-source.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { decryptSecret, encryptSecret, isSecretsEnabled } from '../lib/crypto.ts';

export const CATALOG_SOURCE_SETTING_KEY = 'distribution.catalogSource';
export const CATALOG_PUBLIC_KEY_SETTING_KEY = 'distribution.catalogPublicKey';
export const CATALOG_TOKEN_SECRET_KEY = 'distribution.catalogToken';

export type CatalogChannel = 'stable' | 'beta';

/** 生效中的分发源配置（已归一化）。`repository: null` 表示显式离线。 */
export interface CatalogSourceConfig {
  repository: string | null;
  channel: CatalogChannel;
  ref: string;
  mirror: string | null;
  /** 目录验签公钥（PEM）；null 表示未配置。 */
  publicKey: string | null;
  /**
   * 该公钥的 keyId（与 `catalog.sig.keyId` 必须一致）。
   *
   * 验签是按 keyId 在信任根里找 key 的，因此只给 PEM 不给 keyId 等于永远找不到。
   * 以前把 env/后台配置的公钥硬塞成 `env-catalog-key`，而目录签出来的是
   * `catalog-2026`——配置了也一定验签失败。keyId 必须和公钥一起下发。
   */
  publicKeyId: string | null;
  /** 只读 token；仅用于 GitHub 主机。null 表示未配置。 */
  token: string | null;
}

/** 配置来源，用于后台提示「这一项来自哪里」。 */
export interface CatalogSourceConfigView {
  repository: string | null;
  channel: CatalogChannel;
  ref: string;
  mirror: string | null;
  /** 目录验签公钥（PEM）；null 表示未配置。 */
  publicKey: string | null;
  /** 该公钥的 keyId（对应 `catalog.sig.keyId`）。 */
  publicKeyId: string | null;
  /** 是否已保存只读 token（**不返回明文**）。 */
  tokenConfigured: boolean;
  /** `stored` = 数据库覆盖；`env` = 环境变量/内核默认。 */
  source: 'stored' | 'env';
  /** 环境变量里是否也给了值（覆盖后仍然可见）。 */
  envRepository: string | null;
  envMirror: string | null;
  /** 密钥存储是否可用（不可用时 token 不能保存）。 */
  secretsEnabled: boolean;
}

const ENV_DEFAULTS = (): CatalogSourceConfig => {
  const repository = env.DISTRIBUTION_CATALOG_REPOSITORY ?? null;
  const explicitKey = env.DISTRIBUTION_CATALOG_PUBLIC_KEY ?? null;
  // 默认源与默认信任根是一对：只内置仓库地址而不内置公钥，开箱就会「连得上却验签
  // 失败」。只在仓库**正是**默认源时注入，避免把官方目录的 key 悄悄绑到第三方仓库；
  // 显式 `off` 时 repository 为 null，同样不注入。
  const useBuiltInKey = !explicitKey && repository === DEFAULT_CATALOG_REPOSITORY;
  return {
    repository,
    channel: env.DISTRIBUTION_CATALOG_CHANNEL,
    ref: env.DISTRIBUTION_CATALOG_REF,
    mirror: normalizeMirror(env.DISTRIBUTION_CATALOG_MIRROR) ?? null,
    publicKey: explicitKey ?? (useBuiltInKey ? DEFAULT_CATALOG_PUBLIC_KEY : null),
    publicKeyId: explicitKey
      ? (env.DISTRIBUTION_CATALOG_KEY_ID ?? null)
      : useBuiltInKey
        ? DEFAULT_CATALOG_KEY_ID
        : null,
    token: env.DISTRIBUTION_CATALOG_TOKEN ?? null,
  };
};

/**
 * 进程内缓存。构建应用是同步的（`buildApp()`），而读配置是异步的，因此启动时
 * 由入口先 `await loadCatalogSourceConfig()` 预热；之后同步读取走缓存。
 */
let cached: CatalogSourceConfig | null = null;
let cachedSource: 'stored' | 'env' = 'env';

/** 同步读取当前生效配置（未预热时回退到环境变量）。 */
export function currentCatalogSourceConfig(): CatalogSourceConfig {
  return cached ?? ENV_DEFAULTS();
}

/** 配置来自数据库还是环境变量。 */
export function currentCatalogSourceConfigSource(): 'stored' | 'env' {
  return cachedSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseChannel(value: unknown): CatalogChannel | null {
  return value === 'stable' || value === 'beta' ? value : null;
}

function parseRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  return /^[A-Za-z0-9._\/-]{1,120}$/.test(ref) ? ref : null;
}

/** 解析数据库里的源配置；非法字段整体忽略该字段（回退到环境变量）。 */
function parseStoredSource(value: unknown): Partial<CatalogSourceConfig> | null {
  if (!isRecord(value)) return null;
  const parsed: Partial<CatalogSourceConfig> = {};
  // 显式 `repository: null` 是合法值（表示「关掉远程目录」），不能用 `??` 吞掉。
  if ('repository' in value) {
    const repository = value.repository;
    if (repository === null) parsed.repository = null;
    else if (typeof repository === 'string') {
      try {
        parsed.repository = normalizeCatalogRepository(repository) ?? null;
      } catch {
        // 非法值不生效，保持环境变量兜底。
      }
    }
  }
  const channel = parseChannel(value.channel);
  if (channel) parsed.channel = channel;
  const ref = parseRef(value.ref);
  if (ref) parsed.ref = ref;
  if ('mirror' in value) {
    const mirror = value.mirror;
    if (mirror === null) parsed.mirror = null;
    else if (typeof mirror === 'string') {
      try {
        parsed.mirror = normalizeMirror(mirror) ?? null;
      } catch {
        // 同上。
      }
    }
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function storedPublicKey(value: unknown): { publicKey: string; publicKeyId: string | null } | null {
  if (!isRecord(value)) return null;
  const key = value.publicKey;
  if (typeof key !== 'string' || key.trim().length === 0) return null;
  const keyId = value.keyId;
  return {
    publicKey: key,
    publicKeyId: typeof keyId === 'string' && keyId.trim().length > 0 ? keyId.trim() : null,
  };
}

/** 读取加密保存的只读 token（未启用密钥存储或未配置时为 null）。 */
async function readStoredToken(): Promise<string | null> {
  if (!isSecretsEnabled()) return null;
  try {
    const row = await getPrisma().secret.findUnique({
      where: { key: CATALOG_TOKEN_SECRET_KEY },
    });
    return row ? decryptSecret(row.ciphertext) : null;
  } catch {
    // 解密失败（换了 SETTINGS_ENCRYPTION_KEY）不能让整个实例起不来。
    return null;
  }
}

/**
 * 重新加载生效配置。数据库有行时覆盖环境变量；否则完全用环境变量（含默认源）。
 * 同时把 token 读进缓存，供同步路径使用。
 */
export async function loadCatalogSourceConfig(): Promise<CatalogSourceConfig> {
  const base = ENV_DEFAULTS();
  let stored: Partial<CatalogSourceConfig> | null = null;
  let storedKey: { publicKey: string; publicKeyId: string | null } | null = null;
  let token: string | null = null;
  try {
    const prisma = getPrisma();
    const [sourceRow, keyRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: CATALOG_SOURCE_SETTING_KEY } }),
      prisma.setting.findUnique({ where: { key: CATALOG_PUBLIC_KEY_SETTING_KEY } }),
    ]);
    stored = parseStoredSource(sourceRow?.value);
    storedKey = storedPublicKey(keyRow?.value);
    token = await readStoredToken();
  } catch {
    // 数据库不可用（例如首次迁移前）：退回环境变量，不让分发配置阻断启动。
    stored = null;
  }
  const effectiveRepository = stored?.repository !== undefined ? stored.repository : base.repository;
  // 默认信任根只在**生效仓库**仍是内核自带默认源时使用：后台把源换成第三方仓库后，
  // 不能继续用官方目录的 key 去验别人的目录（那会把「官方签名」绑到错误仓库上）。
  const useBuiltInKey =
    !storedKey &&
    !env.DISTRIBUTION_CATALOG_PUBLIC_KEY &&
    effectiveRepository === DEFAULT_CATALOG_REPOSITORY;
  const publicKey =
    storedKey?.publicKey ??
    env.DISTRIBUTION_CATALOG_PUBLIC_KEY ??
    (useBuiltInKey ? DEFAULT_CATALOG_PUBLIC_KEY : null);
  const publicKeyId =
    storedKey?.publicKeyId ??
    (storedKey
      ? env.DISTRIBUTION_CATALOG_KEY_ID ?? null
      : env.DISTRIBUTION_CATALOG_PUBLIC_KEY
        ? (env.DISTRIBUTION_CATALOG_KEY_ID ?? null)
        : useBuiltInKey
          ? DEFAULT_CATALOG_KEY_ID
          : null);
  cached = {
    ...base,
    ...(stored ?? {}),
    publicKey,
    publicKeyId,
    token: token ?? base.token,
  };
  cachedSource = stored ? 'stored' : 'env';
  return cached;
}

/** 供测试重置缓存。 */
export function resetCatalogSourceConfigForTest(): void {
  cached = null;
  cachedSource = 'env';
}

export interface SaveCatalogSourceInput {
  /** `null` 表示显式关闭远程目录。 */
  repository: string | null;
  channel?: CatalogChannel;
  ref?: string;
  /** `null` 表示不使用加速。 */
  mirror: string | null;
}

/**
 * 保存源配置。所有字段先校验再落库——拼错的仓库或明文 HTTP 加速地址会被拒绝，
 * 而不是写进去之后让分发静默失效。
 */
export async function saveCatalogSourceConfig(
  input: SaveCatalogSourceInput,
  updatedBy: string | null,
): Promise<CatalogSourceConfig> {
  const repository =
    input.repository === null ? null : (normalizeCatalogRepository(input.repository) ?? null);
  if (input.channel !== undefined && parseChannel(input.channel) === null) {
    throw new Error(`渠道非法：${input.channel}（应为 stable 或 beta）`);
  }
  const channel = parseChannel(input.channel) ?? env.DISTRIBUTION_CATALOG_CHANNEL;
  if (input.ref !== undefined && parseRef(input.ref) === null) {
    throw new Error(`分支非法：${input.ref}（只允许字母、数字与 . _ / -）`);
  }
  const ref = parseRef(input.ref) ?? env.DISTRIBUTION_CATALOG_REF;
  const mirror = normalizeMirror(input.mirror ?? undefined) ?? null;
  const value: Prisma.InputJsonValue = {
    repository,
    channel,
    ref,
    mirror,
  };
  await getPrisma().setting.upsert({
    where: { key: CATALOG_SOURCE_SETTING_KEY },
    create: { key: CATALOG_SOURCE_SETTING_KEY, value, updatedBy },
    update: { value, updatedBy },
  });
  return loadCatalogSourceConfig();
}

/** 保存目录验签公钥；空串表示清除（回退到环境变量/内核默认）。 */
export async function saveCatalogPublicKey(
  publicKey: string,
  updatedBy: string | null,
  keyId?: string | null,
): Promise<CatalogSourceConfig> {
  const normalized = publicKey.trim();
  const normalizedKeyId = keyId?.trim() ?? '';
  const prisma = getPrisma();
  if (normalized.length === 0) {
    await prisma.setting.deleteMany({ where: { key: CATALOG_PUBLIC_KEY_SETTING_KEY } });
  } else {
    // keyId 与公钥一起存：验签按 keyId 查信任根，只存 PEM 会导致永远匹配不到。
    const value: Prisma.InputJsonValue = normalizedKeyId
      ? { publicKey: normalized, keyId: normalizedKeyId }
      : { publicKey: normalized };
    await prisma.setting.upsert({
      where: { key: CATALOG_PUBLIC_KEY_SETTING_KEY },
      create: { key: CATALOG_PUBLIC_KEY_SETTING_KEY, value, updatedBy },
      update: { value, updatedBy },
    });
  }
  return loadCatalogSourceConfig();
}

/** 保存只读 token（加密）；空串表示清除。 */
export async function saveCatalogToken(
  token: string,
  _updatedBy: string | null,
): Promise<CatalogSourceConfig> {
  const normalized = token.trim();
  const prisma = getPrisma();
  if (normalized.length === 0) {
    await prisma.secret.deleteMany({ where: { key: CATALOG_TOKEN_SECRET_KEY } });
  } else {
    if (!isSecretsEnabled()) {
      throw new Error('密钥存储未配置：请设置 SETTINGS_ENCRYPTION_KEY');
    }
    await prisma.secret.upsert({
      where: { key: CATALOG_TOKEN_SECRET_KEY },
      create: { key: CATALOG_TOKEN_SECRET_KEY, ciphertext: encryptSecret(normalized) },
      update: { ciphertext: encryptSecret(normalized) },
    });
  }
  return loadCatalogSourceConfig();
}

/** 后台展示视图：不返回 token 明文，只说明是否已配置。 */
export function toCatalogSourceView(config: CatalogSourceConfig): CatalogSourceConfigView {
  const base = ENV_DEFAULTS();
  return {
    repository: config.repository,
    channel: config.channel,
    ref: config.ref,
    mirror: config.mirror,
    publicKey: config.publicKey,
    publicKeyId: config.publicKeyId,
    tokenConfigured: config.token !== null,
    source: cachedSource,
    envRepository: base.repository,
    envMirror: base.mirror,
    secretsEnabled: isSecretsEnabled(),
  };
}
