import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@stackpanel/db';
import { buildMcpTools } from '@stackpanel/sdk';
import { CAPABILITIES, capabilitiesFor } from '../../src/lib/capability-registry.ts';

vi.mock('../../src/config/env.ts', () => ({ env: {} }));
vi.mock('../../src/lib/frontend.ts', () => ({ readFrontendManifest: async () => ({ settingsSchema: {
  groups: [{ id: 'hero', fields: [{ name: 'title', type: 'text', default: 'Default' }, { name: 'links', type: 'list', fields: [{ name: 'label', type: 'text' }, { name: 'href', type: 'text' }], default: [] }] }],
} }) }));
import { configurationVersion, readThemeConfiguration, readThemeConfigurationDraft, saveThemeConfiguration, saveThemeConfigurationDraft, validateThemeConfiguration } from '../../src/lib/theme-configuration.ts';

let values: Map<string, unknown>;
const db = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => values.has(where.key) ? { value: values.get(where.key) } : null,
    upsert: async ({ where, create, update }: { where: { key: string }; create: { value: unknown }; update: { value: unknown } }) => { values.set(where.key, values.has(where.key) ? update.value : create.value); },
  },
  $queryRaw: async () => [],
  $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
    const backup = new Map(values);
    try { return await run(db); } catch (error) { values = backup; throw error; }
  },
} as unknown as PrismaClient;
beforeEach(() => { values = new Map(); });

describe('theme JSON configuration shared by browser and MCP', () => {
  it('returns populated defaults and stable versions irrespective of property order', async () => {
    const current = await readThemeConfiguration(db, 'default');
    expect(current.settings).toEqual({ hero: { title: 'Default', links: [] } });
    expect(configurationVersion({ hero: { title: 'Default', links: [] } })).toBe(configurationVersion({ hero: { links: [], title: 'Default' } }));
  });
  it('accepts partial patches and repeatable links and stores a recoverable snapshot', async () => {
    const current = await readThemeConfiguration(db, 'default');
    const result = await saveThemeConfiguration(db, 'default', { hero: { links: [{ label: 'Shop', href: '/shop' }] } }, 'admin', current.version);
    expect(result.settings.hero?.title).toBe('Default');
    const updated = await readThemeConfiguration(db, 'default');
    expect(updated.history).toHaveLength(1);
    await saveThemeConfiguration(db, 'default', updated.history[0]!.settings, 'admin', updated.version);
    expect((await readThemeConfiguration(db, 'default')).settings).toEqual(current.settings);
  });
  it('rejects stale revisions and leaves both settings and history unchanged', async () => {
    const { version } = await readThemeConfiguration(db, 'default');
    await saveThemeConfiguration(db, 'default', { hero: { title: 'Changed by AI' } }, 'admin', version);
    const before = await readThemeConfiguration(db, 'default');
    await expect(saveThemeConfiguration(db, 'default', { hero: { title: 'Stale browser' } }, 'admin', version)).rejects.toMatchObject({ status: 409 });
    expect(await readThemeConfiguration(db, 'default')).toEqual(before);
  });
  it('rejects invalid types and unknown fields without saving', async () => {
    await expect(validateThemeConfiguration(db, 'default', { hero: { typo: 'x' } })).rejects.toMatchObject({ status: 422 });
    await expect(saveThemeConfiguration(db, 'default', { hero: { title: 42 } } as never, 'admin')).rejects.toThrow();
    expect(values.size).toBe(0);
  });
  it('retains only 20 snapshots and does not create snapshots for no-op saves', async () => {
    for (let n = 0; n < 25; n++) await saveThemeConfiguration(db, 'default', { hero: { title: `v${n}` } }, 'admin');
    const current = await readThemeConfiguration(db, 'default');
    expect(current.history).toHaveLength(20);
    await saveThemeConfiguration(db, 'default', current.settings, 'admin', current.version);
    expect((await readThemeConfiguration(db, 'default')).history).toEqual(current.history);
  });
  it('isolates drafts by administrator and expires them without changing public settings', async () => {
    vi.useFakeTimers();
    try {
      await saveThemeConfigurationDraft(db, 'default', 'admin-a', { hero: { title: 'Draft' } });
      expect((await readThemeConfigurationDraft(db, 'default', 'admin-a'))?.hero?.title).toBe('Draft');
      expect(await readThemeConfigurationDraft(db, 'default', 'admin-b')).toBeNull();
      expect((await readThemeConfiguration(db, 'default')).settings.hero?.title).toBe('Default');
      vi.advanceTimersByTime(10 * 60_000 + 1);
      expect(await readThemeConfigurationDraft(db, 'default', 'admin-a')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('exposes theme tools only to administrators and requires MCP write opt-in', () => {
    expect(capabilitiesFor(['user'], []).some(cap => cap.id.startsWith('theme.configuration'))).toBe(false);
    const capabilities = capabilitiesFor(['platform.admin'], []);
    const themeCaps = capabilities.filter(cap => cap.id.startsWith('theme.configuration'));
    expect(themeCaps).toHaveLength(3);
    expect(buildMcpTools(themeCaps, new Set(['platform.admin'])).length).toBe(2);
    expect(buildMcpTools(themeCaps, new Set(['platform.admin', 'mcp.write'])).length).toBe(3);
    expect(CAPABILITIES.find(cap => cap.id === 'theme.configuration.write')?.path).toBe('/api/v1/themes/:id/configuration');
  });
});
