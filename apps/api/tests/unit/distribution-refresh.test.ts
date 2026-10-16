import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { catalogDigest } from '../../src/distribution/signatures.ts';
import { MemorySourceCache } from '../../src/distribution/github-source.ts';
import { FileSourceCache, cacheFileName } from '../../src/distribution/source-cache.ts';
import { FileCatalogStateStore } from '../../src/distribution/catalog-state.ts';
import {
  backoffMs,
  CatalogRefreshService,
  DEFAULT_REFRESH_INTERVAL_MS,
} from '../../src/distribution/refresh-service.ts';
import type { CatalogSnapshot, Keyring } from '@stackpanel/spec';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function signCatalog(privateKey: ReturnType<typeof keypair>['privateKey'], bytes: Uint8Array) {
  const digest = catalogDigest(bytes);
  return {
    algorithm: 'ed25519' as const,
    keyId: 'catalog-2026',
    digest,
    signature: edSign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64'),
  };
}

function snapshot(
  sequence: number,
  expiresAt = '2026-10-30T00:00:00.000Z',
  generatedAt = '2026-10-16T00:00:00.000Z',
): CatalogSnapshot {
  return {
    formatVersion: 1,
    sequence,
    generatedAt,
    expiresAt,
    channels: [{ channel: 'stable', sequence }],
    publishers: [
      {
        publisher: 'stackpanel',
        keyIds: ['catalog-2026'],
        repositories: ['worable233/stackpanel-market'],
      },
    ],
    entries: [],
  };
}

const REPO = 'worable233/stackpanel-market';
const raw = (tag: string, file: string) =>
  `https://raw.githubusercontent.com/${REPO}/${tag}/${file}`;

function keyringFor(publicKeyPem: string): Keyring {
  return {
    formatVersion: 1,
    keys: [
      {
        keyId: 'catalog-2026',
        purpose: 'catalog',
        publicKeyPem,
        allowedRepositories: [REPO],
      },
    ],
  };
}

/** Fake GitHub returning a valid signed catalog at `sequence`. */
function fakeGitHub(
  privateKey: ReturnType<typeof keypair>['privateKey'],
  sequence: number,
  overrides: { channelsSequence?: number; expiresAt?: string; generatedAt?: string } = {},
) {
  const body = JSON.stringify(snapshot(sequence, overrides.expiresAt, overrides.generatedAt));
  const sig = JSON.stringify(signCatalog(privateKey, new TextEncoder().encode(body)));
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url === raw('main', 'channels.json')) {
      return new Response(
        JSON.stringify({ channels: [{ channel: 'stable', sequence: overrides.channelsSequence ?? sequence }] }),
      );
    }
    if (url === raw(`catalog-v1/${sequence}`, 'catalog.json')) return new Response(body);
    if (url === raw(`catalog-v1/${sequence}`, 'catalog.sig')) return new Response(sig);
    return new Response('not found', { status: 404 });
  });
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'sp-dist-'));
}

describe('FileSourceCache', () => {
  it('persists entries across instances and maps keys to stable safe names', async () => {
    const root = await tempDir();
    const key = 'https://raw.githubusercontent.com/x/y/z/../../etc';
    const first = new FileSourceCache({ rootDir: root });
    await first.set(key, { body: 'ok', etag: 'W/"1"', fetchedAt: '2026-10-16T00:00:00Z' });

    // A fresh instance (simulating a restart) reads it back from disk.
    const second = new FileSourceCache({ rootDir: root });
    const entry = await second.get(key);
    expect(entry?.body).toBe('ok');
    expect(entry?.etag).toBe('W/"1"');

    // The file name is a hash, so no traversal/host chars leak into the path.
    const name = cacheFileName(key);
    expect(name).toMatch(/^[a-f0-9]{64}\.json$/);
    const raw2 = await readFile(path.join(root, name), 'utf8');
    expect(JSON.parse(raw2).body).toBe('ok');
  });

  it('degrades to memory when the cache root is not writable', async () => {
    // A path under an existing *file* cannot be a directory → mkdir fails.
    const file = path.join(await tempDir(), 'not-a-dir');
    await writeFile(file, 'x');
    const cache = new FileSourceCache({ rootDir: path.join(file, 'cache') });
    await cache.set('k', { body: 'v', fetchedAt: '2026-10-16T00:00:00Z' });
    expect((await cache.get('k'))?.body).toBe('v'); // served from memory
  });

  it('ignores corrupt cache files instead of throwing', async () => {
    const root = await tempDir();
    const cache = new FileSourceCache({ rootDir: root });
    await writeFile(path.join(root, cacheFileName('bad')), 'not json');
    expect(await cache.get('bad')).toBeNull();
  });
});

describe('FileCatalogStateStore', () => {
  it('persists the highest sequence and never decreases it', async () => {
    const file = path.join(await tempDir(), 'catalog-state.json');
    const store = new FileCatalogStateStore(file);
    expect((await store.read()).highestSequence).toBe(0);

    await store.advance(7, 'stable', new Date('2026-10-16T00:00:00Z'));
    await store.advance(3, 'stable', new Date('2026-10-16T00:01:00Z')); // lower must not regress
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.highestSequence).toBe(7);
    expect(persisted.lastChannel).toBe('stable');

    // A fresh instance sees the persisted high-water mark.
    expect((await new FileCatalogStateStore(file).read()).highestSequence).toBe(7);
  });

  it('treats an unreadable state file as empty', async () => {
    const file = path.join(await tempDir(), 'missing.json');
    expect((await new FileCatalogStateStore(file).read()).highestSequence).toBe(0);
  });
});

describe('CatalogRefreshService', () => {
  async function service(
    fetchImpl: ReturnType<typeof fakeGitHub>,
    stateFile: string,
    publicKeyPem: string,
  ) {
    return new CatalogRefreshService({
      options: { repository: REPO, channel: 'stable', fetchImpl },
      cache: new MemorySourceCache(),
      state: new FileCatalogStateStore(stateFile),
      loadKeyring: async () => keyringFor(publicKeyPem),
      now: () => new Date('2026-10-16T00:00:00Z'),
    });
  }

  it('refreshes, verifies, advances the replay guard, and exposes current()', async () => {
    const { publicKeyPem, privateKey } = keypair();
    const svc = await service(fakeGitHub(privateKey, 7), path.join(await tempDir(), 's.json'), publicKeyPem);
    const result = await svc.refresh();
    expect(result.resolved?.sequence).toBe(7);
    expect(result.failure).toBeNull();
    expect(svc.current()?.sequence).toBe(7);
  });

  it('coalesces concurrent refreshes into a single network request', async () => {
    const { publicKeyPem, privateKey } = keypair();
    let calls = 0;
    const base = fakeGitHub(privateKey, 7);
    const counting = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      calls += 1;
      return base(input);
    });
    const svc = await service(counting, path.join(await tempDir(), 's.json'), publicKeyPem);
    const [a, b, c] = await Promise.all([svc.refresh(), svc.refresh(), svc.refresh()]);
    expect(a.resolved?.sequence).toBe(7);
    expect(b.resolved?.sequence).toBe(7);
    expect(c.resolved?.sequence).toBe(7);
    // channels.json + catalog.json + catalog.sig, exactly once (not 3×).
    expect(calls).toBe(3);
  });

  it('rejects a replay of an older sequence after a higher one is recorded', async () => {
    const { publicKeyPem, privateKey } = keypair();
    const stateFile = path.join(await tempDir(), 's.json');
    // First refresh sees sequence 9.
    const first = await service(fakeGitHub(privateKey, 9), stateFile, publicKeyPem);
    expect((await first.refresh()).resolved?.sequence).toBe(9);

    // A later attempt to serve sequence 5 (still validly signed) must be rejected.
    const replay = await service(fakeGitHub(privateKey, 5), stateFile, publicKeyPem);
    const result = await replay.refresh();
    expect(result.resolved).toBeNull();
    expect(result.failure?.kind).toBe('replay');
    // Replay never advances or resets the guard.
    expect((await new FileCatalogStateStore(stateFile).read()).highestSequence).toBe(9);
  });

  it('classifies a signature failure and backs off without advancing the guard', async () => {
    const trusted = keypair(); // the keyring trusts this public key
    const stranger = keypair(); // but the catalog is signed by a different key
    const stateFile = path.join(await tempDir(), 's.json');
    const svc = await service(fakeGitHub(stranger.privateKey, 7), stateFile, trusted.publicKeyPem);
    const result = await svc.refresh();
    expect(result.resolved).toBeNull();
    expect(result.failure?.kind).toBe('signature');
    expect(svc.cooldownRemainingMs()).toBeGreaterThan(0);
    expect((await new FileCatalogStateStore(stateFile).read()).highestSequence).toBe(0);
  });

  it('surfaces an expired catalog but still resolves it for cached display', async () => {
    const { publicKeyPem, privateKey } = keypair();
    const svc = await service(
      fakeGitHub(privateKey, 7, {
        expiresAt: '2026-10-15T00:00:00.000Z',
        generatedAt: '2026-10-01T00:00:00.000Z',
      }),
      path.join(await tempDir(), 's.json'),
      publicKeyPem,
    );
    const result = await svc.refresh();
    expect(result.resolved?.expired).toBe(true);
  });
});

describe('backoff', () => {
  it('grows exponentially and caps at the refresh interval', () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(100)).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });
});
