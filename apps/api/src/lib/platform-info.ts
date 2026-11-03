import type { Prisma } from '@stackpanel/db';
import { DEFAULT_PLATFORM_INFO, type PlatformInfo } from '@stackpanel/sdk';
import { getPrisma } from '../plugins/prisma.ts';

export const PLATFORM_INFO_SETTING_KEY = 'platform.info';

/**
 * 进程内缓存。
 *
 * `/platform/info` 是**每个页面渲染**都要打的公开端点（web 侧的根 layout、
 * SEO canonical、FrontendRoute 各读一次），而它每次都要查一次 Setting 表 ——
 * 一份几乎从不变化的数据被反复读。
 *
 * 缓存的是**解析后的对象**：设置行是单行 JSON，读出来再解析不值得每次都做。
 * 写入时立即失效（见 `setPlatformInfo`），所以改平台名/地址立刻生效，
 * 不需要等 TTL。
 */
let cached: PlatformInfo | null = null;

/** Read the validated public platform identity, falling back to stable defaults. */
export async function getPlatformInfo(): Promise<PlatformInfo> {
  if (cached) return cached;
  const row = await getPrisma().setting.findUnique({ where: { key: PLATFORM_INFO_SETTING_KEY } });
  cached = parsePlatformInfo(row?.value);
  return cached;
}

/** 丢弃进程内缓存（写入后调用；测试也用它隔离用例）。 */
export function invalidatePlatformInfo(): void {
  cached = null;
}

/** Persist the validated platform identity under its reserved settings key. */
export async function setPlatformInfo(
  info: PlatformInfo,
  updatedBy: string | null,
): Promise<PlatformInfo> {
  const prisma = getPrisma();
  await prisma.setting.upsert({
    where: { key: PLATFORM_INFO_SETTING_KEY },
    create: {
      key: PLATFORM_INFO_SETTING_KEY,
      value: info as unknown as Prisma.InputJsonValue,
      updatedBy,
    },
    update: {
      value: info as unknown as Prisma.InputJsonValue,
      updatedBy,
    },
  });
  // 写后立即失效：否则改完平台信息要等缓存过期才看得到。
  cached = info;
  return info;
}

function parsePlatformInfo(value: unknown): PlatformInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_PLATFORM_INFO;
  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
  const url = typeof candidate.url === 'string' ? candidate.url.trim() : null;
  if (
    name.length === 0 ||
    name.length > 80 ||
    description.length === 0 ||
    description.length > 280 ||
    (url !== null && !isPublicHttpUrl(url))
  ) {
    return DEFAULT_PLATFORM_INFO;
  }
  const brandDisplay =
    candidate.brandDisplay === 'icon' ||
    candidate.brandDisplay === 'name' ||
    candidate.brandDisplay === 'both'
      ? candidate.brandDisplay
      : 'both';
  return { name, description, url: url || null, brandDisplay };
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
