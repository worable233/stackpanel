import { context } from './context';
import { configModel, type ReferralConfig } from './data';

/** The single config row id. */
export const CONFIG_NAME = 'default';

/** Read the referral config, creating the default row on first use. */
export async function loadConfig(): Promise<ReferralConfig> {
  const extensions = context().extensions;
  const existing = await extensions.get<ReferralConfig>(configModel, CONFIG_NAME);
  if (existing) return existing.spec;
  const created = await extensions.create<ReferralConfig>(
    configModel,
    configModel.schema.parse({}) as ReferralConfig,
    { name: CONFIG_NAME },
  );
  return created.spec;
}

/** Overwrite the config row with a validated full document. */
export async function saveConfig(input: ReferralConfig): Promise<ReferralConfig> {
  const extensions = context().extensions;
  const spec = configModel.schema.parse(input) as ReferralConfig;
  const existing = await extensions.get<ReferralConfig>(configModel, CONFIG_NAME);
  if (!existing) {
    const created = await extensions.create<ReferralConfig>(configModel, spec, {
      name: CONFIG_NAME,
    });
    return created.spec;
  }
  const updated = await extensions.update<ReferralConfig>(configModel, CONFIG_NAME, spec, {
    expectedVersion: existing.version,
  });
  return updated.spec;
}
