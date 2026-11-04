import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CatalogSnapshot, Keyring } from '@stackpanel/spec';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { createAdminUser } from '../auth-helpers.ts';
import { catalogDigest } from '../../src/distribution/signatures.ts';
import { MemorySourceCache } from '../../src/distribution/github-source.ts';
import { FileCatalogStateStore } from '../../src/distribution/catalog-state.ts';
import { CatalogRefreshService } from '../../src/distribution/refresh-service.ts';
import {
  resetCatalogRefreshForTest,
  setCatalogRefreshForTest,
} from '../../src/distribution/runtime.ts';

const dbAvailable = await (async () => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

const CATALOG_REPO = 'worable233/stackpanel-market';
const rawUrl = (tag: string, file: string) =>
  `https://raw.githubusercontent.com/${CATALOG_REPO}/${tag}/${file}`;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function catalogSnapshot(): CatalogSnapshot {
  return {
    formatVersion: 1,
    sequence: 4,
    generatedAt: '2026-10-16T00:00:00.000Z',
    expiresAt: '2026-12-30T00:00:00.000Z',
    channels: [{ channel: 'stable', sequence: 4 }],
    publishers: [
      {
        publisher: 'stackpanel',
        keyIds: ['pkg-1'],
        repositories: ['worable233/stackpanel-plugins'],
      },
    ],
    entries: [
      {
        formatVersion: 1,
        kind: 'plugin',
        id: 'remote-analytics',
        version: '1.0.0',
        channel: 'stable',
        source: {
          repository: 'worable233/stackpanel-plugins',
          tag: 'remote-analytics-v1.0.0',
          asset: 'remote-analytics-1.0.0.zip',
        },
        artifact: { sha256: 'a'.repeat(64), size: 100 },
        compatibility: {
          kernel: '>=0.1.0 <0.3.0',
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
        name: 'Remote Analytics',
        description: '从 Release 安装的分析插件',
      },
      {
        // 目录里有它、但要求的内核版本比当前跑的高：安装必须被兼容门禁挡住，
        // 且要给出可辨认的错误码（而不是一句「安装失败」）。
        formatVersion: 1,
        kind: 'plugin',
        id: 'remote-needs-newer-kernel',
        version: '2.0.0',
        channel: 'stable',
        source: {
          repository: 'worable233/stackpanel-plugins',
          tag: 'remote-needs-newer-kernel-v2.0.0',
          asset: 'remote-needs-newer-kernel-2.0.0.zip',
        },
        artifact: { sha256: 'b'.repeat(64), size: 100 },
        compatibility: {
          kernel: '>=9.0.0',
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
        name: 'Remote Needs Newer Kernel',
      },
    ],
  };
}

describe.skipIf(!dbAvailable)('admin market with a signed remote catalog', () => {
  let app: FastifyInstance;
  let stateDir: string;
  const email = `it_market_catalog_${Date.now()}@example.com`;
  const password = 'test_password_123456';
  let adminToken: string;

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'sp-market-it-'));
    const { publicKeyPem, privateKey } = keypair();
    const body = JSON.stringify(catalogSnapshot());
    const digest = catalogDigest(new TextEncoder().encode(body));
    const signature = {
      algorithm: 'ed25519' as const,
      keyId: 'catalog-2026',
      digest,
      signature: edSign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64'),
    };
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === rawUrl('main', 'channels.json')) {
        return new Response(JSON.stringify({ channels: [{ channel: 'stable', sequence: 4 }] }));
      }
      if (url === rawUrl('catalog-v1/4', 'catalog.json')) return new Response(body);
      if (url === rawUrl('catalog-v1/4', 'catalog.sig'))
        return new Response(JSON.stringify(signature));
      return new Response('not found', { status: 404 });
    });
    const keyring: Keyring = {
      formatVersion: 1,
      keys: [
        {
          keyId: 'catalog-2026',
          purpose: 'catalog',
          publicKeyPem,
          allowedRepositories: [CATALOG_REPO],
        },
        {
          keyId: 'pkg-1',
          purpose: 'package',
          publicKeyPem,
          publisher: 'stackpanel',
          allowedRepositories: ['worable233/stackpanel-plugins'],
        },
      ],
    };
    const service = new CatalogRefreshService({
      options: { repository: CATALOG_REPO, channel: 'stable', fetchImpl },
      cache: new MemorySourceCache(),
      state: new FileCatalogStateStore(path.join(stateDir, 'catalog-state.json')),
      loadKeyring: async () => keyring,
      now: () => new Date('2026-10-16T00:00:00Z'),
    });
    setCatalogRefreshForTest(service);

    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    await app.pluginRuntime.activate('market');
    const admin = await createAdminUser(app, email, password);
    adminToken = admin.token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
    resetCatalogRefreshForTest();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('surfaces remote catalog plugins alongside local ones', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/market/admin/plugins',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { plugins } = res.json() as {
      plugins: Array<{ id: string; name: string; version: string; installed: boolean }>;
    };
    const remote = plugins.find((plugin) => plugin.id === 'remote-analytics');
    expect(remote).toBeDefined();
    expect(remote?.version).toBe('1.0.0');
    expect(remote?.name).toBe('Remote Analytics');
    expect(remote?.installed).toBe(false);
    // Local sources still present (merge, not replace).
    expect(plugins.some((plugin) => plugin.id === 'store')).toBe(true);
  });

  it('reports a clear error when the remote package cannot be fetched', async () => {
    // remote-analytics is in the catalog but its Release asset is not served by
    // the fake GitHub, so fetch fails and nothing is installed. The failure must
    // carry a stable code the UI can translate (ADR-0012 §4), not a bare 500.
    const res = await app.inject({
      method: 'POST',
      url: '/market/admin/plugins/remote-analytics/install',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    const body = res.json() as Record<string, unknown>;
    expect(body.installed).toBeUndefined();
    expect(body.code).toBe('market.sourceUnavailable');
    expect(typeof body.detail).toBe('string');
    expect(String(body.detail)).toContain('remote-analytics');
  });

  it('exposes a manual catalog refresh for the cold-start case', async () => {
    // 进程重启后内存里没有快照；渲染路径不出网（ADR-0027），所以后台必须有显式
    // 刷新入口，否则市场页会永远停在「等待首次刷新」。
    const res = await app.inject({
      method: 'POST',
      url: '/market/admin/refresh',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    // 冷却期内是 429（带 retry-after），真的刷新成功是 200 + 序列。
    expect([200, 429]).toContain(res.statusCode);
    const body = res.json() as Record<string, unknown>;
    if (res.statusCode === 200) {
      expect(body.refreshed).toBe(true);
      expect(body.sequence).toBe(4);
    } else {
      expect(body.code).toBe('market.refreshThrottled');
      expect(res.headers['retry-after']).toBeDefined();
    }
  });

  it('rejects a catalog entry the running kernel cannot satisfy, with its own code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/market/admin/plugins/remote-needs-newer-kernel/install',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    // 兼容门禁与「下载不到」是两件事：前者升内核或换版本，后者查网络。
    expect(res.statusCode).toBe(422);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe('market.packageBlocked');
    expect(body.installed).toBeUndefined();
  });
});
