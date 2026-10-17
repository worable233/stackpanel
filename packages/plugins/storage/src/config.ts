import { context } from './context';
import { configModel, type StoragePluginConfig } from './data';

/** The single config row id. */
export const CONFIG_NAME = 'default';

/** Secret keys owned by this plugin (never stored in the config model). */
export const SECRET_ACCESS_KEY_ID = 's3.access-key-id';
export const SECRET_SECRET_ACCESS_KEY = 's3.secret-access-key';

/** Read the storage config, creating the default (env) row on first use. */
export async function loadConfig(): Promise<StoragePluginConfig> {
  const extensions = context().extensions;
  const existing = await extensions.get<StoragePluginConfig>(configModel, CONFIG_NAME);
  if (existing) return existing.spec;
  const created = await extensions.create<StoragePluginConfig>(
    configModel,
    configModel.schema.parse({}) as StoragePluginConfig,
    { name: CONFIG_NAME },
  );
  return created.spec;
}

/** Overwrite the config row with a validated full document. */
export async function saveConfig(input: StoragePluginConfig): Promise<StoragePluginConfig> {
  const extensions = context().extensions;
  const spec = configModel.schema.parse(input) as StoragePluginConfig;
  const existing = await extensions.get<StoragePluginConfig>(configModel, CONFIG_NAME);
  if (!existing) {
    const created = await extensions.create<StoragePluginConfig>(configModel, spec, {
      name: CONFIG_NAME,
    });
    return created.spec;
  }
  const updated = await extensions.update<StoragePluginConfig>(configModel, CONFIG_NAME, spec, {
    expectedVersion: existing.version,
  });
  return updated.spec;
}
