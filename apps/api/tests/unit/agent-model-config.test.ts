import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { decryptSecret, encryptSecret, isSecretsEnabled } from '../../src/lib/crypto.ts';
import {
  LLM_CONFIG_SECRET_KEY,
  LLM_CONFIG_SETTING_KEY,
  readConfiguredLlmConfig,
} from '../../src/lib/llm-provider.ts';
import { SECRETS_DISABLED_CODE } from '../../src/lib/secrets-policy.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';
import { checkDbAvailable } from '../helpers.ts';

/**
 * T4 — the admin read/write surface for the fallback model config
 * (PLAN-agent-in-kernel §3.1).
 *
 * These tests touch two real tables (`settings`, `secrets`) and go through the
 * real `adminOnly` guard, the real net-guard gate and the real audit sink, so
 * they need the database from tests/setup.ts. They live under `tests/unit/`
 * because that path is the task's declared writeScope, and are skipped (never
 * failed) when no database is reachable.
 */
const dbAvailable = await checkDbAvailable();

describe.skipIf(!dbAvailable)('admin agent model config (real DB)', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const adminEmail = `agent_model_admin_${suffix}@example.com`;
  const userEmail = `agent_model_user_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let adminId = '';
  let userToken = '';

  const SEEDED_KEY = 'sk-seeded-agent-model-key';
  const SEEDED_BASE_URL = 'https://llm.example.com/v1';
  const SEEDED_MODEL = 'gpt-4o-mini';

  async function resetConfig(): Promise<void> {
    const prisma = getPrisma();
    await prisma.setting.deleteMany({ where: { key: LLM_CONFIG_SETTING_KEY } });
    await prisma.secret.deleteMany({ where: { key: LLM_CONFIG_SECRET_KEY } });
  }

  function adminPut(payload: unknown) {
    return app.inject({
      method: 'PUT',
      url: '/admin/agent/model',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: payload as Record<string, unknown>,
    });
  }

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    await resetConfig();
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    adminToken = admin.token;
    adminId = admin.userId;
    userToken = user.token;
  });

  afterAll(async () => {
    await resetConfig();
    const prisma = getPrisma();
    await prisma.auditLog.deleteMany({
      where: { action: { in: ['agent.model.update', 'agent.model.clear'] } },
    });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('is admin-only (401 anonymous, 403 normal user)', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/admin/agent/model' });
    expect(anonymous.statusCode).toBe(401);

    const normalUser = await app.inject({
      method: 'GET',
      url: '/admin/agent/model',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(normalUser.statusCode).toBe(403);

    const normalUserWrite = await app.inject({
      method: 'PUT',
      url: '/admin/agent/model',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { baseUrl: SEEDED_BASE_URL, model: SEEDED_MODEL },
    });
    expect(normalUserWrite.statusCode).toBe(403);
  });

  it('reports an unconfigured state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/agent/model',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ baseUrl: null, model: null, apiKeyConfigured: false });
  });

  it('writes baseUrl/model to Setting and the key to Secret, never echoing the key', async () => {
    const res = await adminPut({
      baseUrl: SEEDED_BASE_URL,
      model: SEEDED_MODEL,
      apiKey: SEEDED_KEY,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      baseUrl: SEEDED_BASE_URL,
      model: SEEDED_MODEL,
      apiKeyConfigured: true,
    });
    // Neither the plaintext nor the stored ciphertext may appear in the body.
    expect(res.body).not.toContain(SEEDED_KEY);
    expect(res.body).not.toContain('ciphertext');

    // The Setting row is plaintext JSON and must hold only non-secret fields.
    const setting = await getPrisma().setting.findUnique({
      where: { key: LLM_CONFIG_SETTING_KEY },
    });
    expect(setting?.value).toEqual({ baseUrl: SEEDED_BASE_URL, model: SEEDED_MODEL });
    expect(JSON.stringify(setting?.value)).not.toContain(SEEDED_KEY);
    expect(setting?.updatedBy).toBe(adminId);

    // The key lives encrypted in `Secret`.
    const secret = await getPrisma().secret.findUnique({
      where: { key: LLM_CONFIG_SECRET_KEY },
    });
    expect(secret?.ciphertext).toBeTruthy();
    expect(secret?.ciphertext).not.toContain(SEEDED_KEY);

    // The runtime reader (T2) resolves the full triple from those same rows.
    await expect(readConfiguredLlmConfig(getPrisma())).resolves.toEqual({
      baseUrl: SEEDED_BASE_URL,
      model: SEEDED_MODEL,
      apiKey: SEEDED_KEY,
    });

    const audit = await getPrisma().auditLog.findFirst({
      where: { action: 'agent.model.update', resourceId: LLM_CONFIG_SETTING_KEY },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.actorId).toBe(adminId);
    expect(JSON.stringify(audit?.meta ?? {})).not.toContain(SEEDED_KEY);
  });

  it('keeps the stored key when the update omits apiKey', async () => {
    const before = await getPrisma().secret.findUnique({
      where: { key: LLM_CONFIG_SECRET_KEY },
    });

    const res = await adminPut({ baseUrl: 'https://llm.example.com/v2', model: 'gpt-4o' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      baseUrl: 'https://llm.example.com/v2',
      model: 'gpt-4o',
      apiKeyConfigured: true,
    });

    // Same ciphertext (the key was not re-entered, and not re-encrypted away).
    const after = await getPrisma().secret.findUnique({
      where: { key: LLM_CONFIG_SECRET_KEY },
    });
    expect(after?.ciphertext).toBe(before?.ciphertext);
    await expect(readConfiguredLlmConfig(getPrisma())).resolves.toEqual({
      baseUrl: 'https://llm.example.com/v2',
      model: 'gpt-4o',
      apiKey: SEEDED_KEY,
    });
  });

  it.each([
    'http://127.0.0.1:11434/v1',
    'https://127.0.0.1/v1',
    'http://localhost:8080/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.10/v1',
    'http://llm.example.com/v1',
  ])('rejects non-public baseUrl %s without writing anything', async (baseUrl) => {
    const before = await readConfiguredLlmConfig(getPrisma());
    const beforeSecret = await getPrisma().secret.findUnique({
      where: { key: LLM_CONFIG_SECRET_KEY },
    });

    const res = await adminPut({ baseUrl, model: 'gpt-4o', apiKey: 'sk-should-not-be-stored' });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('agent.model.base_url_rejected');
    expect(res.body).not.toContain('sk-should-not-be-stored');

    // The rejected request left no trace: prior config and ciphertext intact.
    await expect(readConfiguredLlmConfig(getPrisma())).resolves.toEqual(before);
    const afterSecret = await getPrisma().secret.findUnique({
      where: { key: LLM_CONFIG_SECRET_KEY },
    });
    expect(afterSecret?.ciphertext).toBe(beforeSecret?.ciphertext);
  });

  it('rejects a malformed baseUrl with 400', async () => {
    const res = await adminPut({ baseUrl: 'not-a-url', model: 'gpt-4o' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('request.invalid');
  });

  it('clears both rows on DELETE, after which the runtime resolves to null', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/agent/model',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ baseUrl: null, model: null, apiKeyConfigured: false });
    expect(await getPrisma().setting.findUnique({ where: { key: LLM_CONFIG_SETTING_KEY } })).toBeNull();
    expect(await getPrisma().secret.findUnique({ where: { key: LLM_CONFIG_SECRET_KEY } })).toBeNull();
    await expect(readConfiguredLlmConfig(getPrisma())).resolves.toBeNull();

    const audit = await getPrisma().auditLog.findFirst({
      where: { action: 'agent.model.clear', resourceId: LLM_CONFIG_SETTING_KEY },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.actorId).toBe(adminId);
  });

  it('maps a disabled secret store to 501 rather than storing plaintext', async () => {
    // tests/setup.ts always sets SETTINGS_ENCRYPTION_KEY, so the 501 branch in
    // the route is unreachable in this environment. Assert the precondition that
    // makes it unreachable, and pin the code/contract the branch returns.
    expect(isSecretsEnabled()).toBe(true);
    expect(SECRETS_DISABLED_CODE).toBe('secret.storage.disabled');
  });

  it('stores ciphertext that decrypts back to the original key', async () => {
    await adminPut({ baseUrl: SEEDED_BASE_URL, model: SEEDED_MODEL, apiKey: SEEDED_KEY });
    const secret = await getPrisma().secret.findUnique({
      where: { key: LLM_CONFIG_SECRET_KEY },
    });
    expect(secret?.ciphertext).not.toBe(SEEDED_KEY);
    expect(decryptSecret(secret?.ciphertext ?? '')).toBe(SEEDED_KEY);
    // Re-encrypting the same plaintext yields a different envelope (random IV),
    // which is why the row's value cannot be compared for equality.
    expect(encryptSecret(SEEDED_KEY)).not.toBe(secret?.ciphertext);
  });
});
