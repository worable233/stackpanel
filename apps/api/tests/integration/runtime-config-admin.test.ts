import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import {
  getConfig,
  getConfigSource,
  loadRuntimeConfig,
  resetRuntimeConfigForTest,
  runtimeConfigSettingKey,
} from '../../src/config/runtime-config.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * 运行期配置（ADR-0026）的后台接口，跑真实数据库。
 *
 * 重点不是"接口返回 200"，而是**写入真的改变了运行期行为**：`PUT /admin/config`
 * 之后同进程的 `getConfig()` 必须立刻用上新值；`DELETE` 之后必须回到环境变量。
 * 这条链路里任何一环断了（校验/落库/快照/广播）设置页都会变成"能改但不生效"，
 * 而这正是本次改造要消灭的失败模式。
 */
describe.skipIf(!dbAvailable)('runtime config admin API (real DB)', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const adminEmail = `runtime_config_admin_${suffix}@example.com`;
  const userEmail = `runtime_config_user_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';

  const cleanup = async (): Promise<void> => {
    const prisma = getPrisma();
    await prisma.setting.deleteMany({
      where: {
        key: {
          in: [
            runtimeConfigSettingKey('SESSION_TTL_SECONDS'),
            runtimeConfigSettingKey('AUTH_CODE_TTL_SECONDS'),
          ],
        },
      },
    });
  };

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    await cleanup();
    await loadRuntimeConfig();
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    adminToken = admin.token;
    userToken = user.token;
  });

  afterAll(async () => {
    await cleanup();
    resetRuntimeConfigForTest();
    await app.close();
  });

  const get = (url: string, token = adminToken): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  const put = (
    url: string,
    payload: Record<string, unknown>,
    token = adminToken,
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'PUT',
      url,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
  const del = (url: string, token = adminToken): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${token}` } });

  it('lists only whitelisted keys with their effective value and source', async () => {
    const response = await get('/admin/config');
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      entries: { name: string; value: unknown; source: string }[];
    };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.some((entry) => entry.name === 'AUTH_CAPTCHA_MODE')).toBe(true);
    // A secret must never appear as an editable row.
    expect(body.entries.some((entry) => entry.name === 'JWT_SECRET')).toBe(false);
  });

  it('rejects every verb for a non-admin', async () => {
    // 这些写入口能改变全站会话寿命、上传上限、限流额度，必须只有管理员能碰。
    expect((await get('/admin/config', userToken)).statusCode).toBe(403);
    expect(
      (await put('/admin/config/SESSION_TTL_SECONDS', { value: '900' }, userToken)).statusCode,
    ).toBe(403);
    expect((await del('/admin/config/SESSION_TTL_SECONDS', userToken)).statusCode).toBe(403);
  });

  it('stores an override and applies it to the running process immediately', async () => {
    const response = await put('/admin/config/SESSION_TTL_SECONDS', { value: '900' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      entries: { name: string; value: unknown; source: string }[];
    };
    const entry = body.entries.find((item) => item.name === 'SESSION_TTL_SECONDS');
    expect(entry?.value).toBe(900);
    expect(entry?.source).toBe('stored');
    // The point of the whole mechanism: the runtime reads the new value at once.
    expect(getConfig('SESSION_TTL_SECONDS')).toBe(900);
    expect(getConfigSource('SESSION_TTL_SECONDS')).toBe('stored');
    // Persisted, not just cached in memory.
    const row = await getPrisma().setting.findUnique({
      where: { key: runtimeConfigSettingKey('SESSION_TTL_SECONDS') },
    });
    expect(row?.value).toBe(900);
    // A fresh process (snapshot reload) sees it too.
    resetRuntimeConfigForTest();
    await loadRuntimeConfig();
    expect(getConfig('SESSION_TTL_SECONDS')).toBe(900);
  });

  it('rejects values the runtime could not parse, and unknown keys', async () => {
    const invalid = await put('/admin/config/AUTH_CODE_TTL_SECONDS', { value: 'not-a-number' });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { code?: string }).code).toBe('config.invalid_value');

    const negative = await put('/admin/config/AUTH_CODE_TTL_SECONDS', { value: -5 });
    expect(negative.statusCode).toBe(400);

    const unknown = await put('/admin/config/JWT_SECRET', { value: 'attacker-controlled' });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { code?: string }).code).toBe('config.unknown_key');
    // Nothing was written for the rejected keys.
    expect(
      await getPrisma().setting.findUnique({ where: { key: 'config.JWT_SECRET' } }),
    ).toBeNull();
  });

  it('reverts to the environment value when the override is removed', async () => {
    await put('/admin/config/SESSION_TTL_SECONDS', { value: '900' });
    const response = await del('/admin/config/SESSION_TTL_SECONDS');
    expect(response.statusCode).toBe(200);
    expect(getConfigSource('SESSION_TTL_SECONDS')).not.toBe('stored');
    expect(
      await getPrisma().setting.findUnique({
        where: { key: runtimeConfigSettingKey('SESSION_TTL_SECONDS') },
      }),
    ).toBeNull();
    const body = response.json() as { entries: { name: string; source: string }[] };
    expect(body.entries.find((item) => item.name === 'SESSION_TTL_SECONDS')?.source).not.toBe(
      'stored',
    );
  });
});
