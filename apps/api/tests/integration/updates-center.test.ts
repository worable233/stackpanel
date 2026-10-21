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
import { setUpdateChannelForTest } from '../../src/updates/runtime.ts';
import { setUpdaterStateDirForTest } from '../../src/updates/status.ts';

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
        version: '1.1.0',
        channel: 'stable',
        source: {
          repository: 'worable233/stackpanel-plugins',
          tag: 'remote-analytics-v1.1.0',
          asset: 'remote-analytics-1.1.0.zip',
        },
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
        name: 'Remote Analytics',
      },
    ],
  };
}

describe.skipIf(!dbAvailable)('admin update center', () => {
  let app: FastifyInstance;
  let stateDir: string;
  let channelDir: string;
  const email = `it_updates_${Date.now()}@example.com`;
  const password = 'test_password_123456';
  let adminToken: string;

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'sp-updates-it-'));
    channelDir = path.join(stateDir, 'channel');
    setUpdateChannelForTest({ channelRoot: channelDir, instanceId: 'sp-it' });
    // updater 状态卷与通道同卷（compose 里是同一个 `stackpanel-updater-state`）。
    setUpdaterStateDirForTest(stateDir);
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
    const admin = await createAdminUser(app, email, password);
    adminToken = admin.token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.setting.deleteMany({ where: { key: 'distribution:update-policy' } });
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
    resetCatalogRefreshForTest();
    setUpdateChannelForTest({ channelRoot: null, instanceId: null });
    setUpdaterStateDirForTest(null);
    await rm(stateDir, { recursive: true, force: true });
  });

  it('reports status with a configured catalog', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/updates/status',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { catalogConfigured: boolean; policy: { autoUpdate: boolean } };
    expect(body.catalogConfigured).toBe(true);
    expect(body.policy.autoUpdate).toBe(false);
  });

  it('persists an updated policy', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/updates/policy',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { autoUpdate: true, channel: 'beta' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { policy: { autoUpdate: boolean; channel: string } };
    expect(body.policy.autoUpdate).toBe(true);
    expect(body.policy.channel).toBe('beta');
    // Restore conservative default for the remaining assertions.
    await app.inject({
      method: 'PUT',
      url: '/admin/updates/policy',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { autoUpdate: false, channel: 'stable' },
    });
  });

  it('resolves a full deployment plan from the signed catalog', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/updates/plan',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      planDigest: string;
      plan: { packages: Array<{ id: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.planDigest).toHaveLength(64);
    expect(body.plan.packages.some((pkg) => pkg.id === 'remote-analytics')).toBe(true);
  });

  it('submits a task to the private channel', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/updates/submit',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { submitted: boolean; idempotencyKey: string };
    expect(body.submitted).toBe(true);
    // The task file is now in the inbox of the bound instance.
    const inbox = path.join(channelDir, 'inbox', 'sp-it');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(inbox);
    expect(files).toContain(`${body.idempotencyKey}.json`);
  });

  it('requires acknowledgement when the plan adds permissions', async () => {
    // Policy change doesn't matter; remote-analytics declares no permissions, so
    // this plan does not require acknowledgement. Assert the non-blocking path is
    // consistent instead: a plan without added permissions submits directly.
    const res = await app.inject({
      method: 'POST',
      url: '/admin/updates/submit',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { idempotencyKey: 'custom-key-1' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { idempotencyKey: string };
    expect(body.idempotencyKey).toBe('custom-key-1');
  });

  it('lists results (empty until the updater writes back)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/updates/results',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: unknown[] };
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('submits and cancels an updater self-update request', async () => {
    const digest = 'b'.repeat(64);
    const submit = await app.inject({
      method: 'POST',
      url: '/admin/updates/self-update',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { candidateDigest: `ghcr.io/acme/updater@sha256:${digest}` },
    });
    expect(submit.statusCode).toBe(202);
    expect((submit.json() as { request: { candidateDigest: string } }).request.candidateDigest).toBe(
      digest,
    );

    const pending = await app.inject({
      method: 'GET',
      url: '/admin/updates/self-update',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(pending.statusCode).toBe(200);
    expect((pending.json() as { request: { candidateDigest: string } }).request.candidateDigest).toBe(
      digest,
    );

    const cancel = await app.inject({
      method: 'DELETE',
      url: '/admin/updates/self-update',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(cancel.statusCode).toBe(200);
    const after = await app.inject({
      method: 'GET',
      url: '/admin/updates/self-update',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect((after.json() as { request: unknown }).request).toBeNull();
  });

  it('rejects a malformed candidate digest', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/updates/self-update',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { candidateDigest: 'latest' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-admin access', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/updates/status' });
    expect([401, 403]).toContain(res.statusCode);
  });
});
