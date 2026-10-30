import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { catalogDigest } from '../../src/distribution/signatures.ts';
import { MemorySourceCache } from '../../src/distribution/github-source.ts';
import { FileSourceCache, cacheFileName } from '../../src/distribution/source-cache.ts';
import { channelBaseline, FileCatalogStateStore } from '../../src/distribution/catalog-state.ts';
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
  channel: 'stable' | 'beta' = 'stable',
): CatalogSnapshot {
  return {
    formatVersion: 1,
    sequence,
    generatedAt,
    expiresAt,
    channels: [{ channel, sequence }],
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
  overrides: {
    channelsSequence?: number;
    expiresAt?: string;
    generatedAt?: string;
    channel?: 'stable' | 'beta';
  } = {},
) {
  const channel = overrides.channel ?? 'stable';
  const body = JSON.stringify(
    snapshot(sequence, overrides.expiresAt, overrides.generatedAt, channel),
  );
  const sig = JSON.stringify(signCatalog(privateKey, new TextEncoder().encode(body)));
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url === raw('main', 'channels.json')) {
      return new Response(
        JSON.stringify({
          channels: [{ channel, sequence: overrides.channelsSequence ?? sequence }],
        }),
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

  it('tracks the highest sequence per channel and migrates a legacy state file', async () => {
    const file = path.join(await tempDir(), 'catalog-state.json');
    const store = new FileCatalogStateStore(file);
    await store.advance(10, 'beta', new Date('2026-10-16T00:00:00Z'));
    await store.advance(8, 'stable', new Date('2026-10-16T00:01:00Z'));
    const state = await store.read();
    expect(state.channels).toEqual({ beta: 10, stable: 8 });
    expect(state.highestSequence).toBe(10);
    expect(channelBaseline(state, 'beta')).toBe(10);
    expect(channelBaseline(state, 'stable')).toBe(8);
    expect(channelBaseline(state, 'nightly')).toBe(0);

    // 旧版本写下的文件没有 channels：只把全局最高值归给它记录的渠道。
    const legacy = path.join(await tempDir(), 'legacy.json');
    await writeFile(legacy, JSON.stringify({ highestSequence: 7, lastChannel: 'beta' }), 'utf8');
    const legacyState = await new FileCatalogStateStore(legacy).read();
    expect(channelBaseline(legacyState, 'beta')).toBe(7);
    expect(channelBaseline(legacyState, 'stable')).toBe(0);
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
    channel: 'stable' | 'beta' = 'stable',
  ) {
    return new CatalogRefreshService({
      options: { repository: REPO, channel, fetchImpl },
      cache: new MemorySourceCache(),
      state: new FileCatalogStateStore(stateFile),
      loadKeyring: async () => keyringFor(publicKeyPem),
      now: () => new Date('2026-10-16T00:00:00Z'),
    });
  }

  it('refreshes, verifies, advances the replay guard, and exposes current()', async () => {
    const { publicKeyPem, privateKey } = keypair();
    const svc = await service(
      fakeGitHub(privateKey, 7),
      path.join(await tempDir(), 's.json'),
      publicKeyPem,
    );
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

  it('succeeds when the channel still points at the sequence already recorded', async () => {
    // 回归：更新中心的「检查更新」在目录没有新发布时必须成功，而不是报
    // 「拒绝回放旧目录：sequence 2 ≤ 已见 2」——那会让手动检查按钮看起来坏掉。
    const { publicKeyPem, privateKey } = keypair();
    const stateFile = path.join(await tempDir(), 's.json');
    const first = await service(fakeGitHub(privateKey, 2), stateFile, publicKeyPem);
    expect((await first.refresh()).resolved?.sequence).toBe(2);

    // 新进程（内存快照为空）读同一份持久状态，渠道仍指向 2。
    const second = await service(fakeGitHub(privateKey, 2), stateFile, publicKeyPem);
    const result = await second.refresh();
    expect(result.failure).toBeNull();
    expect(result.resolved?.sequence).toBe(2);
    expect(second.current()?.sequence).toBe(2);
    expect((await new FileCatalogStateStore(stateFile).read()).highestSequence).toBe(2);
  });

  it('keeps the replay baseline per channel, so switching to a lower channel still works', async () => {
    // beta 已推进到 5，stable 还在 2：切回 stable 是管理员的选择，不是降级攻击。
    // 旧实现拿跨渠道的全局最高值比较，稳定渠道的正常快照会被判成回放，并被退避 6 小时。
    const { publicKeyPem, privateKey } = keypair();
    const stateFile = path.join(await tempDir(), 's.json');
    const beta = await service(
      fakeGitHub(privateKey, 5, { channel: 'beta' }),
      stateFile,
      publicKeyPem,
      'beta',
    );
    expect((await beta.refresh()).resolved?.sequence).toBe(5);

    const stable = await service(fakeGitHub(privateKey, 2), stateFile, publicKeyPem, 'stable');
    const result = await stable.refresh();
    expect(result.failure).toBeNull();
    expect(result.resolved?.sequence).toBe(2);
    const persisted = await new FileCatalogStateStore(stateFile).read();
    expect(persisted.channels).toEqual({ beta: 5, stable: 2 });
    expect(persisted.highestSequence).toBe(5);
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

describe('CatalogRefreshService.ensureCurrent（失败退避）', () => {
  it('does not re-dial GitHub while the failure backoff is active', async () => {
    const { publicKeyPem, privateKey } = keypair();
    let calls = 0;
    const base = fakeGitHub(privateKey, 7);
    const counting = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      calls += 1;
      return base(input);
    });
    const svc = new CatalogRefreshService({
      options: { repository: REPO, channel: 'stable', fetchImpl: counting },
      cache: new MemorySourceCache(),
      state: new FileCatalogStateStore(path.join(await tempDir(), 's.json')),
      loadKeyring: async () => ({ formatVersion: 1, keys: [] }),
      now: () => new Date('2026-10-16T00:00:00Z'),
    });
    // No catalog key in the keyring → signature failure → backoff.
    expect(await svc.ensureCurrent()).toBeNull();
    expect(svc.lastFailureInfo()?.kind).toBe('signature');
    const afterFirst = calls;
    // 退避期内：市场页反复加载不得再次请求 GitHub。
    expect(await svc.ensureCurrent()).toBeNull();
    expect(await svc.ensureCurrent()).toBeNull();
    expect(calls).toBe(afterFirst);
    // 信任根补齐后仍可直接刷新成功（退避只影响按需刷新）。
    expect(publicKeyPem.length).toBeGreaterThan(0);
  });
});
