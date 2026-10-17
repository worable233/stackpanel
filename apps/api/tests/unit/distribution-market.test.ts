import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { signPackageFiles } from '@stackpanel/spec';
import type { CatalogEntry, CatalogSnapshot, Keyring } from '@stackpanel/spec';
import {
  CatalogMarketError,
  catalogEntriesFor,
  catalogInstalledVersion,
  listCatalogMarketEntries,
  prepareCatalogInstall,
} from '../../src/lib/market-catalog.ts';
import { MemorySourceCache } from '../../src/distribution/github-source.ts';
import { catalogMarketPackageView } from '../../src/lib/market.ts';

const REPO = 'worable233/stackpanel-plugins';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    formatVersion: 1,
    kind: 'plugin',
    id: 'demo',
    version: '1.0.0',
    channel: 'stable',
    source: { repository: REPO, tag: 'demo-v1.0.0', asset: 'demo-1.0.0.zip' },
    artifact: { sha256: 'a'.repeat(64), size: 100 },
    compatibility: {
      kernel: '>=0.2.0 <0.3.0',
      kernelApi: '^0.4.0',
      frontendAbi: '^1.0.0',
      packageFormat: 1,
    },
    requires: [],
    conflicts: [],
    permissions: [],
    frontendModes: ['M2'],
    migration: { mode: 'none', rollback: 'code-compatible' },
    automatic: { eligible: true },
    publisher: 'stackpanel',
    name: 'Demo',
    ...overrides,
  };
}

function catalog(entries: CatalogEntry[]): CatalogSnapshot {
  return {
    formatVersion: 1,
    sequence: 7,
    generatedAt: '2026-10-16T00:00:00.000Z',
    expiresAt: '2026-12-30T00:00:00.000Z',
    channels: [{ channel: 'stable', sequence: 7 }],
    publishers: [{ publisher: 'stackpanel', keyIds: ['pkg-1'], repositories: [REPO] }],
    entries,
  };
}

function keyring(publicKeyPem: string): Keyring {
  return {
    formatVersion: 1,
    keys: [
      {
        keyId: 'pkg-1',
        purpose: 'package',
        publicKeyPem,
        publisher: 'stackpanel',
        allowedRepositories: [REPO],
      },
    ],
  };
}

/** Build a signed plugin ZIP plus the matching catalog entry. */
function signedPluginZip(
  privateKeyPem: string,
  files: Array<[string, string]>,
  overrides: Partial<CatalogEntry> = {},
): { zip: Uint8Array; entry: CatalogEntry } {
  const records: Array<[string, Uint8Array]> = files.map(
    ([name, body]) => [name, new TextEncoder().encode(body)] as [string, Uint8Array],
  );
  const signature = signPackageFiles(records, privateKeyPem);
  const record: Record<string, Uint8Array> = {};
  for (const [name, data] of records) record[name] = data;
  record['signature.json'] = new TextEncoder().encode(JSON.stringify(signature));
  const zip = zipSync(record);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  return {
    zip,
    entry: entry({
      artifact: { sha256, size: zip.byteLength },
      ...overrides,
    }),
  };
}

function fetchForZip(zip: Uint8Array, asset: string): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/repos/')) {
      return new Response(
        JSON.stringify({
          assets: [
            {
              name: asset,
              size: zip.byteLength,
              browser_download_url: 'https://objects.githubusercontent.com/pkg',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(zip, { status: 200 });
  });
}

describe('listCatalogMarketEntries / catalogEntriesFor', () => {
  it('groups by (kind,id), picks the highest version, drops revoked, and flags incompatible blocks', () => {
    const snapshot = catalog([
      entry({ version: '1.0.0' }),
      entry({ version: '1.2.0' }),
      entry({ version: '0.9.0', revoked: true }),
      entry({
        kind: 'plugin',
        id: 'legacy',
        version: '2.0.0',
        compatibility: {
          kernel: '>=9.0.0',
          kernelApi: '^0.4.0',
          frontendAbi: '^1.0.0',
          packageFormat: 1,
        },
      }),
    ]);
    expect(catalogEntriesFor(snapshot, 'plugin', 'demo').map((e) => e.version)).toEqual([
      '1.2.0',
      '1.0.0',
    ]);
    return listCatalogMarketEntries(snapshot, 'plugin').then((entries) => {
      expect(entries.map((e) => e.id)).toEqual(['demo', 'legacy']);
      const demo = entries.find((e) => e.id === 'demo');
      expect(demo?.version).toBe('1.2.0');
      expect(demo?.blocks).toEqual([]);
      const legacy = entries.find((e) => e.id === 'legacy');
      expect(legacy?.blocks.some((b) => b.code === 'incompatible_kernel')).toBe(true);
    });
  });

  it('maps a catalog entry to a MarketPackage view with installed state', () => {
    const view = catalogMarketPackageView(
      { id: 'demo', kind: 'plugin', name: 'Demo', version: '1.2.0', blocks: [] },
      '1.0.0',
    );
    expect(view).toMatchObject({
      id: 'demo',
      kind: 'plugin',
      installed: true,
      installedVersion: '1.0.0',
      upgradable: true,
      current: false,
      builtin: false,
    });
  });
});

describe('prepareCatalogInstall', () => {
  let dataDir: string;
  let previous: string | undefined;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'sp-mkt-'));
    previous = process.env['STACKPANEL_DATA_DIR'];
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env['STACKPANEL_DATA_DIR'];
    else process.env['STACKPANEL_DATA_DIR'] = previous;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('resolves, verifies by keyring binding, validates the package, and stages (uncommitted)', async () => {
    const { privateKeyPem, publicKeyPem } = keypair();
    const { zip, entry: catalogEntry } = signedPluginZip(privateKeyPem, [
      ['manifest.json', JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0' })],
      ['dist/index.js', 'export default {}'],
    ]);
    const prepared = await prepareCatalogInstall(
      {
        catalog: catalog([catalogEntry]),
        keyring: keyring(publicKeyPem),
        cache: new MemorySourceCache(),
        channel: 'stable',
        fetchImpl: fetchForZip(zip, 'demo-1.0.0.zip'),
      },
      'plugin',
      'demo',
    );
    expect(prepared.version).toBe('1.0.0');
    expect(prepared.publisher).toBe('stackpanel');
    expect(prepared.upgraded).toBe(false);
    // Staging already switched the directory in; commit drops the backup.
    expect(
      await readFile(path.join(dataDir, 'plugins', 'demo', 'manifest.json'), 'utf8'),
    ).toContain('1.0.0');
    await prepared.handle.commit();
    expect(await catalogInstalledVersion('plugin', 'demo')).toBe('1.0.0');
  });

  it('rolls back to the previous package version on abort', async () => {
    const { privateKeyPem, publicKeyPem } = keypair();
    const first = signedPluginZip(privateKeyPem, [
      ['manifest.json', JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0' })],
      ['dist/index.js', 'export default {}'],
    ]);
    const v1 = await prepareCatalogInstall(
      {
        catalog: catalog([first.entry]),
        keyring: keyring(publicKeyPem),
        cache: new MemorySourceCache(),
        channel: 'stable',
        fetchImpl: fetchForZip(first.zip, 'demo-1.0.0.zip'),
      },
      'plugin',
      'demo',
    );
    await v1.handle.commit();

    const second = signedPluginZip(
      privateKeyPem,
      [
        ['manifest.json', JSON.stringify({ id: 'demo', name: 'Demo', version: '1.1.0' })],
        ['dist/index.js', 'export default {}'],
      ],
      {
        version: '1.1.0',
        source: { repository: REPO, tag: 'demo-v1.1.0', asset: 'demo-1.1.0.zip' },
      },
    );
    const v2 = await prepareCatalogInstall(
      {
        catalog: catalog([first.entry, second.entry]),
        keyring: keyring(publicKeyPem),
        cache: new MemorySourceCache(),
        channel: 'stable',
        fetchImpl: fetchForZip(second.zip, 'demo-1.1.0.zip'),
      },
      'plugin',
      'demo',
    );
    expect(v2.upgraded).toBe(true);
    await v2.handle.rollback();
    expect(await catalogInstalledVersion('plugin', 'demo')).toBe('1.0.0');
  });

  it('refuses an entry whose publisher is not in the catalog whitelist (no network)', async () => {
    const evil = entry({ publisher: 'evil' });
    const fetchImpl = vi.fn();
    await expect(
      prepareCatalogInstall(
        {
          catalog: catalog([evil]),
          keyring: { formatVersion: 1, keys: [] },
          cache: new MemorySourceCache(),
          channel: 'stable',
          fetchImpl,
        },
        'plugin',
        'demo',
      ),
    ).rejects.toThrow(CatalogMarketError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an id that is not in the catalog', async () => {
    await expect(
      prepareCatalogInstall(
        {
          catalog: catalog([]),
          keyring: { formatVersion: 1, keys: [] },
          cache: new MemorySourceCache(),
          channel: 'stable',
        },
        'plugin',
        'missing',
      ),
    ).rejects.toThrow(/不在目录中/);
  });
});
