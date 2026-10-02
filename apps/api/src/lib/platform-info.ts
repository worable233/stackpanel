import type { Prisma } from '@stackpanel/db';
import { DEFAULT_PLATFORM_INFO, type PlatformInfo } from '@stackpanel/sdk';
import { getPrisma } from '../plugins/prisma.ts';

export const PLATFORM_INFO_SETTING_KEY = 'platform.info';

/** Read the validated public platform identity, falling back to stable defaults. */
export async function getPlatformInfo(): Promise<PlatformInfo> {
  const row = await getPrisma().setting.findUnique({ where: { key: PLATFORM_INFO_SETTING_KEY } });
  return parsePlatformInfo(row?.value);
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
  return { name, description, url: url || null };
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
