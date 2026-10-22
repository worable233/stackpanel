/**
 * 分发源后台配置接口（PLAN-github-distribution §2/§10）。
 *
 * 覆盖权限、参数校验、数据库覆盖环境变量、token 只写不读，以及「关闭远程目录时
 * 刷新接口不触网」。真实网络刷新由注入式单测承担，这里不连 GitHub。
 */
import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import {
  CATALOG_PUBLIC_KEY_SETTING_KEY,
  CATALOG_SOURCE_SETTING_KEY,
  CATALOG_TOKEN_SECRET_KEY,
  loadCatalogSourceConfig,
  resetCatalogSourceConfigForTest,
} from '../../src/distribution/source-config.ts';
import { resetCatalogRefreshForTest } from '../../src/distribution/runtime.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

async function cleanup(): Promise<void> {
  const prisma = getPrisma();
  await prisma.setting.deleteMany({
    where: { key: { in: [CATALOG_SOURCE_SETTING_KEY, CATALOG_PUBLIC_KEY_SETTING_KEY] } },
  });
  await prisma.secret.deleteMany({ where: { key: CATALOG_TOKEN_SECRET_KEY } });
  resetCatalogSourceConfigForTest();
  resetCatalogRefreshForTest();
  await loadCatalogSourceConfig();
}

describe.skipIf(!dbAvailable)('admin distribution source endpoints (real DB)', () => {
  let app: FastifyInstance;
  let adminToken = '';
  let userToken = '';
  const suffix = Date.now();
  const email = `distribution_admin_${suffix}@example.com`;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    await cleanup();
    const admin = await createAdminUser(app, email);
    const user = await createTestUser(app, `distribution_user_${suffix}@example.com`);
    adminToken = admin.token;
    userToken = user.token;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await getPrisma().user.deleteMany({ where: { email } });
  });

  const get = () =>
    app.inject({
      method: 'GET',
      url: '/admin/distribution/source',
      headers: { authorization: `Bearer ${adminToken}` },
    });

  it('requires an admin session', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/admin/distribution/source' });
    expect(anonymous.statusCode).toBe(401);
    const forbidden = await app.inject({
      method: 'GET',
      url: '/admin/distribution/source',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('reports the env-backed defaults before anything is stored', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      source: { repository: string | null; channel: string; ref: string; source: string };
      defaults: { repository: string | null };
    };
    expect(body.source.source).toBe('env');
    // 集成测试套件把 `DISTRIBUTION_CATALOG_REPOSITORY` 钉成 `off`（离线、不触网），
    // 因此这里看到的是「显式关闭」；线上默认源见 unit 测试。
    expect(body.source.repository).toBeNull();
    expect(body.source.channel).toBe('stable');
    expect(body.source.ref).toBe('main');
    expect(body.defaults.repository).toBeNull();
  });

  it('saves a normalized source and marks it as stored', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/distribution/source',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        repository: 'https://github.com/acme/plugins.git',
        channel: 'beta',
        ref: 'dev',
        mirror: 'https://github.chenc.dev/',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      source: { repository: string; channel: string; ref: string; mirror: string; source: string };
    };
    expect(body.source).toMatchObject({
      repository: 'acme/plugins',
      channel: 'beta',
      ref: 'dev',
      mirror: 'https://github.chenc.dev',
      source: 'stored',
    });
  });

  it('rejects a malformed repository and a plain-HTTP mirror', async () => {
    const badRepo = await app.inject({
      method: 'PUT',
      url: '/admin/distribution/source',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { repository: 'not a repo', mirror: null },
    });
    expect(badRepo.statusCode).toBe(422);

    const badMirror = await app.inject({
      method: 'PUT',
      url: '/admin/distribution/source',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { repository: 'acme/plugins', mirror: 'http://ghfast.top' },
    });
    expect(badMirror.statusCode).toBe(422);
    // 专用 code 保留具体原因，避免前端按 `validation.invalid` 泛化掉。
    expect((badMirror.json() as { code: string }).code).toBe('distribution.source.invalid');
    expect((badMirror.json() as { detail: string }).detail).toMatch(/HTTPS/);
    // 之前的配置保持生效，非法写入没有落库。
    const after = await get();
    expect((after.json() as { source: { mirror: string } }).source.mirror).toBe(
      'https://github.chenc.dev',
    );
  });

  it('rejects a catalog key that is not a valid Ed25519 PEM', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/distribution/catalog-key',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { publicKey: 'not-a-key' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('distribution.catalogKey.invalid');
  });

  it('stores the catalog key and the token without echoing the token', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyRes = await app.inject({
      method: 'PUT',
      url: '/admin/distribution/catalog-key',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { publicKey: pem },
    });
    expect(keyRes.statusCode).toBe(200);
    expect((keyRes.json() as { source: { publicKey: string } }).source.publicKey).toBe(pem.trim());

    const tokenRes = await app.inject({
      method: 'PUT',
      url: '/admin/distribution/token',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { token: 'github_pat_integration_secret' },
    });
    expect(tokenRes.statusCode).toBe(200);
    const tokenBody = tokenRes.json() as { source: Record<string, unknown> };
    expect(tokenBody.source.tokenConfigured).toBe(true);
    expect(JSON.stringify(tokenBody)).not.toContain('github_pat_integration_secret');

    const stored = await getPrisma().secret.findUnique({
      where: { key: CATALOG_TOKEN_SECRET_KEY },
    });
    expect(stored?.ciphertext).toBeTruthy();
    expect(stored?.ciphertext).not.toContain('github_pat_integration_secret');

    const cleared = await app.inject({
      method: 'PUT',
      url: '/admin/distribution/token',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { token: '' },
    });
    expect(
      (cleared.json() as { source: { tokenConfigured: boolean } }).source.tokenConfigured,
    ).toBe(false);

    const clearedKey = await app.inject({
      method: 'PUT',
      url: '/admin/distribution/catalog-key',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { publicKey: '' },
    });
    expect(
      (clearedKey.json() as { source: { publicKey: string | null } }).source.publicKey,
    ).toBeNull();
  });

  it('disables the remote catalog with repository: null', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/distribution/source',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { repository: null, mirror: null },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { source: { repository: string | null } }).source.repository).toBeNull();
  });

  it('reports nothing to refresh while the catalog is off (no network)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/distribution/refresh',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, available: false, failure: null });
  });

  it('writes an audit entry for source changes', async () => {
    const audit = await getPrisma().auditLog.findFirst({
      where: { action: 'distribution.source.set' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
  });
});
