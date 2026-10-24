import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@stackpanel/db';
import {
  buildZodFromSettingsSchema,
  mergeFrontendSettings,
  migrateFrontendSettings,
  settingsDefaultsFromSchema,
  PluginError,
  type FrontendSettings,
} from '@stackpanel/sdk';
import { readFrontendManifest } from './frontend.ts';
import { themePackageDir } from './themes.ts';
import {
  frontendSettingKey,
  readStoredFrontendSettings,
  resolveFrontendSettings,
} from './frontend-settings.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const configurationVersion = (settings: FrontendSettings) =>
  createHash('sha256').update(canonical(settings)).digest('hex');
export interface ThemeConfigurationSnapshot {
  version: string;
  savedAt: string;
  settings: FrontendSettings;
}
const draftKey = (id: string, actorId: string) => `theme:${id}:preview:${actorId}`;
export async function saveThemeConfigurationDraft(
  db: PrismaClient,
  id: string,
  actorId: string,
  settings: FrontendSettings,
) {
  const validated = await validateThemeConfiguration(db, id, settings);
  const value = { expiresAt: Date.now() + 10 * 60_000, settings: validated.settings };
  await db.setting.upsert({
    where: { key: draftKey(id, actorId) },
    create: {
      key: draftKey(id, actorId),
      value: value as unknown as Prisma.InputJsonValue,
      updatedBy: actorId,
    },
    update: { value: value as unknown as Prisma.InputJsonValue, updatedBy: actorId },
  });
}
export async function readThemeConfigurationDraft(db: PrismaClient, id: string, actorId: string) {
  const row = await db.setting.findUnique({ where: { key: draftKey(id, actorId) } });
  const value = row?.value as { expiresAt?: number; settings?: FrontendSettings } | null;
  if (!value?.settings || !value.expiresAt || value.expiresAt < Date.now()) return null;
  return value.settings;
}
export async function readThemeConfiguration(db: PrismaClient, id: string) {
  const manifest = await readFrontendManifest(themePackageDir(id));
  if (!manifest?.settingsSchema)
    throw new PluginError('theme.configuration_missing', 404, 'Theme has no configuration schema');
  const schema = manifest.settingsSchema;
  const settings = resolveFrontendSettings(
    schema,
    await readStoredFrontendSettings(db, frontendSettingKey('theme', id)),
  );
  const history = await db.setting.findUnique({ where: { key: `theme:${id}:history` } });
  return {
    schema,
    defaults: settingsDefaultsFromSchema(schema),
    settings,
    version: configurationVersion(settings),
    history: ((history?.value ?? []) as unknown as ThemeConfigurationSnapshot[]).map((entry) => ({
      ...entry,
      settings: resolveFrontendSettings(schema, entry.settings),
    })),
  };
}
export async function validateThemeConfiguration(
  db: PrismaClient,
  id: string,
  patch: FrontendSettings,
) {
  const current = await readThemeConfiguration(db, id);
  // `migrateFrontendSettings` 对空输入返回 undefined；补丁为空时按空对象处理，
  // 而不是用 `!` 断言「一定非空」。断言断言不了这一点，只会把 undefined 带进
  // 下面的 Object.entries。
  const migrated = migrateFrontendSettings(current.schema, patch) ?? {};
  const settings = mergeFrontendSettings(current.settings, migrated);
  // Unknown keys must fail rather than being silently discarded by Zod.
  for (const [group, values] of Object.entries(migrated)) {
    const definition = current.schema.groups.find((item) => item.id === group);
    if (!definition)
      throw new PluginError('theme.configuration_invalid', 422, `Unknown group: ${group}`);
    for (const key of Object.keys(values)) {
      if (!definition.fields.some((field) => field.name === key))
        throw new PluginError('theme.configuration_invalid', 422, `Unknown field: ${group}.${key}`);
    }
  }
  return { ...current, settings: buildZodFromSettingsSchema(current.schema).parse(settings) };
}
export async function saveThemeConfiguration(
  db: PrismaClient,
  id: string,
  patch: FrontendSettings,
  actor: string | null,
  expectedVersion?: string,
) {
  return db.$transaction(async (tx) => {
    const key = frontendSettingKey('theme', id);
    // Serialize writes from both browser and MCP; checking a hash alone races.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
    const client = tx as unknown as PrismaClient;
    const current = await readThemeConfiguration(client, id);
    if (expectedVersion && current.version !== expectedVersion)
      throw new PluginError(
        'theme.configuration_conflict',
        409,
        'Configuration changed. Reload before saving.',
      );
    const validated = await validateThemeConfiguration(client, id, patch);
    const version = configurationVersion(validated.settings);
    if (version !== current.version) {
      const history = [
        { version: current.version, savedAt: new Date().toISOString(), settings: current.settings },
        ...current.history,
      ].slice(0, 20);
      await tx.setting.upsert({
        where: { key: `${key}:history` },
        create: {
          key: `${key}:history`,
          value: history as unknown as Prisma.InputJsonValue,
          updatedBy: actor,
        },
        update: { value: history as unknown as Prisma.InputJsonValue, updatedBy: actor },
      });
      await tx.setting.upsert({
        where: { key },
        create: {
          key,
          value: validated.settings as unknown as Prisma.InputJsonValue,
          updatedBy: actor,
        },
        update: { value: validated.settings as unknown as Prisma.InputJsonValue, updatedBy: actor },
      });
    }
    return { settings: validated.settings, version };
  });
}
