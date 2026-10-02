import type { Prisma, PrismaClient } from '@stackpanel/db';
import {
  buildZodFromSettingsSchema,
  mergeFrontendSettings,
  settingsDefaultsFromSchema,
} from '@stackpanel/sdk';
import type { FrontendSettings, FrontendSettingsSchema } from '@stackpanel/sdk';

export type FrontendKind = 'theme' | 'plugin';

/** Stable settings table key namespace for theme/plugin frontend settings. */
export function frontendSettingKey(kind: FrontendKind, id: string): string {
  return `${kind}:${id}`;
}

/** Read stored settings, normalizing arbitrary JSON into the settings shape. */
export async function readStoredFrontendSettings(
  prisma: PrismaClient,
  key: string,
): Promise<FrontendSettings | undefined> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return normalizeSettings(row?.value);
}

/** Merge stored values over schema defaults and validate the result. */
export function resolveFrontendSettings(
  schema: FrontendSettingsSchema,
  stored: FrontendSettings | undefined,
): FrontendSettings {
  const merged = mergeFrontendSettings(settingsDefaultsFromSchema(schema), stored);
  return buildZodFromSettingsSchema(schema).parse(merged);
}

/** Validate a partial update merged over current settings before saving. */
export async function saveFrontendSettings(
  prisma: PrismaClient,
  key: string,
  schema: FrontendSettingsSchema,
  current: FrontendSettings | undefined,
  patch: FrontendSettings,
  updatedBy: string | null,
): Promise<FrontendSettings> {
  const merged = mergeFrontendSettings(current ?? settingsDefaultsFromSchema(schema), patch);
  const validated = buildZodFromSettingsSchema(schema).parse(merged);
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: validated as unknown as Prisma.InputJsonValue },
    update: {
      value: validated as unknown as Prisma.InputJsonValue,
      updatedBy,
    },
  });
  return validated;
}

function normalizeSettings(value: unknown): FrontendSettings | undefined {
  if (!isRecord(value)) return undefined;
  const result: FrontendSettings = {};
  for (const [group, values] of Object.entries(value)) {
    if (!isRecord(values)) continue;
    const normalized: Record<string, string | number | boolean> = {};
    for (const [name, fieldValue] of Object.entries(values)) {
      if (
        typeof fieldValue === 'string' ||
        typeof fieldValue === 'number' ||
        typeof fieldValue === 'boolean'
      ) {
        normalized[name] = fieldValue;
      }
    }
    result[group] = normalized;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Convert a settings validation failure into a friendly Chinese message. */
export function settingsErrorToMessage(err: unknown): string {
  const issues = (err as { issues?: Array<{ path?: Array<string | number> }> })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const path = issues[0]?.path?.join('.');
    return path ? `设置值无效：${path}` : '设置值无效';
  }
  return err instanceof Error ? err.message : '设置值无效';
}
