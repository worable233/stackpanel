import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as SdkPaths from '@stackpanel/sdk/paths';
import type * as MarketModule from '../../src/lib/market.ts';

const state = vi.hoisted(() => ({ dataDir: '', record: null as null | {
  id: string; name: string; version: string; active: boolean;
}, failWrite: false }));
vi.mock('../../src/config/env.ts', () => ({ env: { PACKAGE_SIGNATURE_REQUIRED: false } }));
vi.mock('@stackpanel/sdk/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof SdkPaths>()),
  resolveStackPanelDataDir: () => state.dataDir,
}));
vi.mock('../../src/plugins/prisma.ts', () => ({
  getPrisma: () => ({ theme: {
    findUnique: async () => state.record,
    update: async ({ data }: { data: Partial<NonNullable<typeof state.record>> }) => {
      if (state.failWrite) throw new Error('registry unavailable');
      state.record = { ...state.record!, ...data };
      return state.record;
    },
    create: async ({ data }: { data: NonNullable<typeof state.record> }) => {
      if (state.failWrite) throw new Error('registry unavailable');
      state.record = data;
      return state.record;
    },
  } }),
}));

let root: string;
let market: typeof MarketModule;
const source = { id: 'test-theme', name: 'Test Theme', version: '2.0.0', sourceDir: '' };

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'market-theme-regression-'));
  source.sourceDir = path.join(root, 'packages/themes/test-theme');
  await mkdir(source.sourceDir, { recursive: true });
  await writeFile(path.join(source.sourceDir, 'package.json'), JSON.stringify({ name: 'test-theme', version: source.version }));
  await writeFile(path.join(source.sourceDir, 'theme.json'), JSON.stringify(source));
  await writeFile(path.join(source.sourceDir, 'theme.css'), ':root { --background: white; }');
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(path.join(root, 'apps/api'));
  try { market = await import('../../src/lib/market.ts'); } finally { cwd.mockRestore(); }
});
beforeEach(async () => {
  state.dataDir = path.join(root, 'data');
  state.record = null;
  state.failWrite = false;
  await rm(state.dataDir, { recursive: true, force: true });
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('local market theme installation registry', () => {
  it('registers a newly installed theme and reports it installed', async () => {
    await market.installMarketTheme(source.id);
    expect(state.record).toEqual({ id: source.id, name: source.name, version: source.version, active: false });
    expect((await market.marketPackageView('theme', source)).installed).toBe(true);
    expect(await readdir(path.join(state.dataDir, 'themes'))).toEqual([source.id]);
  });

  it('preserves activation when reinstalling', async () => {
    await market.installMarketTheme(source.id);
    state.record!.active = true;
    state.record!.version = '1.0.0';
    await market.installMarketTheme(source.id);
    expect(state.record).toMatchObject({ active: true, version: '2.0.0' });
    expect(await readdir(path.join(state.dataDir, 'themes'))).toEqual([source.id]);
  });

  it('does not report unpacked but unregistered files as installed', async () => {
    await market.installMarketTheme(source.id);
    state.record = null;
    expect(await market.marketPackageView('theme', source)).toMatchObject({ installed: false, installedVersion: null, current: false });
  });

  it('restores previous files when registry persistence fails', async () => {
    await market.installMarketTheme(source.id);
    const cssPath = path.join(state.dataDir, 'themes', source.id, 'theme.css');
    await writeFile(cssPath, ':root { --old: retained; }');
    state.failWrite = true;
    await expect(market.installMarketTheme(source.id)).rejects.toThrow('registry unavailable');
    expect(await readFile(cssPath, 'utf8')).toBe(':root { --old: retained; }');
    expect(await readdir(path.join(state.dataDir, 'themes'))).toEqual([source.id]);
  });
});
