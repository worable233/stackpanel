import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * 网关插件本身不在内核仓库里（源码在 StackPanel-plugins，安装产物落在被忽略的
 * `data/plugins/`）。内核工作区里装好网关时这些用例才跑得起来；没有装包时跳过，
 * 免得一次全量测试因为缺一个可选插件而变红。
 */
const gatewayInstalled = existsSync(
  path.join(process.env['STACKPANEL_DATA_DIR'] ?? '', 'plugins', 'llm-gateway', 'manifest.json'),
);

/**
 * End-to-end: 用户签发 key → 经网关转发到 mock 上游 → 按 token 后付费扣钱包。
 *
 * E3 起网关的插件自治数据（账号池 / 策略 / 用量 / 定价 / 历史密钥）落在
 * Extension 引擎物理表；测试按 ADR-0008 用裸 SQL 直接读写这些表，不再依赖内核 Prisma 模型。
 */

const USAGE_TABLE = 'ext_llm-gateway_usage-log';
const POLICY_TABLE = 'ext_llm-gateway_key-policy';
const LEGACY_TABLE = 'ext_llm-gateway_legacy-key';

describe.skipIf(!dbAvailable || !gatewayInstalled)(
  'llm-gateway relay + post-paid billing (real DB)',
  () => {
  let app: FastifyInstance;
  let upstream: Server;
  let upstreamUrl = '';

  const adminEmail = `lg_admin_${Date.now()}@example.com`;
  const userEmail = `lg_user_${Date.now()}@example.com`;
  const viewerEmail = `lg_viewer_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  let userId = '';
  let viewerId = '';
  let apiKeyPlaintext = '';

  /** 最近一次转发到 mock 上游的请求体（用于断言模型名重写）。 */
  let lastUpstreamBody: Record<string, unknown> | null = null;

  /** 与内核/插件同源的凭证哈希。 */
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

  /** 读取某用户最新一条用量流水的 spec。 */
  async function latestUsage(targetUserId: string): Promise<Record<string, unknown> | null> {
    const rows = await getPrisma().$queryRawUnsafe<Array<{ spec: Record<string, unknown> }>>(
      `SELECT "spec" FROM "${USAGE_TABLE}" WHERE "f_userId" = $1 ORDER BY "created_at" DESC LIMIT 1`,
      targetUserId,
    );
    return rows[0]?.spec ?? null;
  }

  /** 读取某凭证的策略 spec。 */
  async function policyOf(apiTokenId: string): Promise<Record<string, unknown> | null> {
    const rows = await getPrisma().$queryRawUnsafe<Array<{ spec: Record<string, unknown> }>>(
      `SELECT "spec" FROM "${POLICY_TABLE}" WHERE "f_apiTokenId" = $1`,
      apiTokenId,
    );
    return rows[0]?.spec ?? null;
  }

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'test-model' }, { id: 'test-model-2' }],
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            lastUpstreamBody = parsed as Record<string, unknown>;
          }
        } catch {
          lastUpstreamBody = null;
        }
        const streaming = raw.includes('"stream":true');
        if (raw.includes('error_probe')) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
          return;
        }
        if (streaming) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\n');
          res.write(
            'data: {"id":"1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (raw.includes('cache_probe')) {
          // 全部输入命中缓存：用于验证缓存读价被真正套用。
          res.end(
            JSON.stringify({
              id: 'chatcmpl-cache',
              choices: [{ message: { role: 'assistant', content: 'hello' } }],
              usage: {
                prompt_tokens: 1_000_000,
                completion_tokens: 0,
                total_tokens: 1_000_000,
                prompt_tokens_details: { cached_tokens: 1_000_000 },
              },
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            choices: [{ message: { role: 'assistant', content: 'hello' } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${address.port}`;

    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    const viewer = await createTestUser(app, viewerEmail, password);
    adminToken = admin.token;
    userToken = user.token;
    userId = user.userId;
    viewerId = viewer.userId;
    // 降权场景：移出该用户的所有权限组，使其不再持有 llm-gateway.use。
    await prisma.userGroup.deleteMany({ where: { userId: viewerId } });

    await prisma.plugin.deleteMany({ where: { id: { in: ['store', 'llm-gateway'] } } });
    const enableStore = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enableStore.statusCode).toBe(200);
    const enableGateway = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/llm-gateway',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enableGateway.statusCode).toBe(200);

    // 给用户钱包充值，供后付费扣款。
    await prisma.walletAccount.create({
      data: { userId, currency: 'CNY', balance: 10_000 },
    });

    // 开启该用户的 API 计费开关（否则网关会 403）。
    const billing = await app.inject({
      method: 'POST',
      url: '/llm-gateway/billing',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { enabled: true },
    });
    expect(billing.statusCode).toBe(200);

    // 管理端配置定价与上游账号。
    const price = await app.inject({
      method: 'POST',
      url: '/llm-gateway/admin/prices',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        model: 'test-model',
        inputPrice: 100,
        outputPrice: 200,
        cacheReadPrice: 10,
        cacheWritePrice: 0,
        multiplier: 100,
      },
    });
    expect(price.statusCode).toBe(201);
    const account = await app.inject({
      method: 'POST',
      url: '/llm-gateway/admin/accounts',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'mock-upstream',
        baseUrl: upstreamUrl,
        apiKey: 'up-secret',
        models: 'test-model',
      },
    });
    expect(account.statusCode).toBe(201);
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.$executeRawUnsafe(`DELETE FROM "${USAGE_TABLE}"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "${POLICY_TABLE}"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "${LEGACY_TABLE}"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_llm-gateway_user-setting"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_llm-gateway_model-price"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_llm-gateway_account"`);
    await prisma.apiToken.deleteMany({ where: { userId: { in: [userId, viewerId] } } });
    await prisma.walletHold.deleteMany({ where: { userId } });
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await prisma.plugin.deleteMany({ where: { id: { in: ['store', 'llm-gateway'] } } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail, viewerEmail] } } });
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('rejects a relay request without an API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      payload: { model: 'test-model' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets a user create a key and shows the plaintext once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/keys',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { name: 'prod', models: 'test-model' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { plaintext: string };
    expect(body.plaintext.startsWith('sp_')).toBe(true);
    apiKeyPlaintext = body.plaintext;

    // 凭证写内核 ApiToken（带 llm-gateway.use scope），策略写插件 key-policy。
    const prisma = getPrisma();
    const stored = await prisma.apiToken.findUnique({
      where: { keyHash: sha256(body.plaintext) },
    });
    expect(stored?.scopes).toEqual(['llm-gateway.use']);
    const policy = await policyOf(stored?.id ?? '');
    expect(policy?.models).toEqual(['test-model']);

    const list = await app.inject({
      method: 'GET',
      url: '/llm-gateway/keys',
      headers: { authorization: `Bearer ${userToken}` },
    });
    const listBody = list.json() as { revealedKey: string | null; keys: unknown[] };
    expect(listBody.revealedKey).toBe(body.plaintext);
    expect(listBody.keys).toHaveLength(1);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/llm-gateway/keys/does-not-exist',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { name: 'renamed' },
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: string }).code).toBe('llm_gateway.key_not_found');
  });

  it('forwards a non-stream request and charges the wallet by token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKeyPlaintext}` },
      payload: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { usage: { total_tokens: number } };
    expect(body.usage.total_tokens).toBe(150);

    const log = await latestUsage(userId);
    expect(log?.totalTokens).toBe(150);
    // 100 * 100/1e6 + 50 * 200/1e6 = 0.02 分 → 至少 1 分。
    expect(log?.amount).toBe(1);
    expect(log?.status).toBe('SUCCESS');

    const prisma = getPrisma();
    const account = await prisma.walletAccount.findFirst({ where: { userId } });
    expect(account?.balance).toBe(9_999);
  });

  it('freezes the estimated cost up front and refunds the unused remainder', async () => {
    const prisma = getPrisma();
    const account = await prisma.walletAccount.findFirstOrThrow({ where: { userId } });
    const startBalance = account.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKeyPlaintext}` },
      payload: {
        model: 'test-model',
        max_tokens: 50_000,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);

    // 预授权必须结算为一个终态，而不是留下 HELD 残影。
    const holds = await prisma.walletHold.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(holds).toHaveLength(1);
    expect(holds[0]?.status).toBe('SETTLED');
    // 实际用量 150 token → 1 分（见上一条用例），预估远超实际，差额必须退回。
    expect(holds[0]?.settledAmount).toBe(1);

    const after = await prisma.walletAccount.findFirstOrThrow({ where: { userId } });
    expect(after.balance).toBe(startBalance - 1);
    // 结算后不应再有冻结残留。
    expect(after.held).toBe(0);
    expect(holds[0]?.amount).toBeGreaterThan(1);
  });

  it('refunds the hold when the request never reaches a settled state', async () => {
    const prisma = getPrisma();
    const account = await prisma.walletAccount.findFirstOrThrow({ where: { userId } });
    const before = account.balance;
    const holdsBefore = await prisma.walletHold.count({ where: { userId } });

    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKeyPlaintext}` },
      payload: {
        model: 'test-model',
        error_probe: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(500);

    // 上游报错也必须把冻结金额归还，不能永久占用用户余额。
    const holds = await prisma.walletHold.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(holds.length).toBe(holdsBefore + 1);
    expect(holds[0]?.status).not.toBe('HELD');

    const after = await prisma.walletAccount.findFirstOrThrow({ where: { userId } });
    expect(after.held).toBe(0);
    expect(after.balance).toBe(before);
  });

  it('charges cached input tokens at the cache-read price', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKeyPlaintext}` },
      payload: {
        model: 'test-model',
        cache_probe: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);

    const log = await latestUsage(userId);
    // 1,000,000 输入 token 全部命中缓存：1e6 * 10/1e6 = 10 分（而非按输入价 100 分）。
    expect(log?.cacheReadTokens).toBe(1_000_000);
    expect(log?.promptTokens).toBe(1_000_000);
    expect(log?.amount).toBe(10);
  });

  it('meters a streamed SSE response via usage chunk', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKeyPlaintext}` },
      payload: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('[DONE]');

    const log = await latestUsage(userId);
    expect(log?.promptTokens).toBe(10);
    expect(log?.completionTokens).toBe(5);
    expect(log?.amount).toBe(1);
  });

  it('blocks a model outside the key allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKeyPlaintext}` },
      payload: { model: 'other-model', messages: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('exposes and toggles the user API billing switch', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/llm-gateway/billing',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(before.statusCode).toBe(200);
    expect((before.json() as { enabled: boolean }).enabled).toBe(true);
    expect((before.json() as { balance: number }).balance).toBeGreaterThan(0);

    const off = await app.inject({
      method: 'POST',
      url: '/llm-gateway/billing',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { enabled: boolean }).enabled).toBe(false);
  });

  it('rejects relay calls while the user billing switch is off', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKeyPlaintext}` },
      payload: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('billing_disabled');

    // 恢复开启，供后续测试使用。
    await app.inject({
      method: 'POST',
      url: '/llm-gateway/billing',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { enabled: true },
    });
  });

  it('fetches the upstream model list for an account', async () => {
    const accounts = await app.inject({
      method: 'GET',
      url: '/llm-gateway/admin/accounts',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const { accounts: list } = accounts.json() as { accounts: Array<{ id: string; name: string }> };
    const target = list.find((account) => account.name === 'mock-upstream');
    expect(target).toBeTruthy();

    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/admin/upstream-models',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { id: target?.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { models: string[] };
    expect(body.models).toEqual(['test-model', 'test-model-2']);
  });

  it('stores an independent model allowlist per account', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/llm-gateway/admin/accounts',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'second-upstream',
        baseUrl: upstreamUrl,
        apiKey: 'up-secret-2',
        models: ['test-model-2'],
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: '/llm-gateway/admin/accounts',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const { accounts: list } = res.json() as {
      accounts: Array<{ name: string; models: string[] }>;
    };
    const second = list.find((account) => account.name === 'second-upstream');
    expect(second?.models).toEqual(['test-model-2']);
  });

  it('maps a public model name to its bound upstream model when forwarding', async () => {
    // 对外卖自定义名 `public-alias`，实际绑定上游 `test-model-2`（由 second-upstream 提供）。
    const price = await app.inject({
      method: 'POST',
      url: '/llm-gateway/admin/prices',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        model: 'public-alias',
        upstreamModel: 'test-model-2',
        inputPrice: 100,
        outputPrice: 200,
        multiplier: 100,
      },
    });
    expect(price.statusCode).toBe(201);
    const saved = price.json() as { price: { model: string; upstreamModel: string } };
    expect(saved.price.model).toBe('public-alias');
    expect(saved.price.upstreamModel).toBe('test-model-2');

    // 放开该 key 的模型白名单，允许调用新对外模型。
    const keys = await app.inject({
      method: 'GET',
      url: '/llm-gateway/keys',
      headers: { authorization: `Bearer ${userToken}` },
    });
    const keyId = (keys.json() as { keys: Array<{ id: string }> }).keys[0]?.id ?? '';
    expect(keyId).toBeTruthy();
    const patched = await app.inject({
      method: 'PATCH',
      url: `/llm-gateway/keys/${keyId}`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { models: ['test-model', 'public-alias'] },
    });
    expect(patched.statusCode).toBe(200);

    lastUpstreamBody = null;
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKeyPlaintext}` },
      payload: { model: 'public-alias', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    // 转发到上游的模型名被改写成绑定的上游模型。
    expect(lastUpstreamBody?.['model']).toBe('test-model-2');

    // 计费仍按对外模型名（其定价行）记录，用户账单看到的是自定义名。
    const log = await latestUsage(userId);
    expect(log?.model).toBe('public-alias');
    expect(log?.amount).toBe(1);
  });

  it('lists only the custom public model names, not the bound upstream ones', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/llm-gateway/v1/models',
      headers: { authorization: `Bearer ${apiKeyPlaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    const ids = body.data.map((model) => model.id);
    expect(ids).toContain('public-alias');
    // 对外的自定义名不应暴露上游真实模型名。
    expect(ids).not.toContain('test-model-2');
  });

  it('aggregates upstream model names for the pricing bind selector', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/llm-gateway/admin/upstream-model-catalog',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { models: string[] };
    // mock 上游的 /v1/models 返回 test-model / test-model-2；账号有限定集合时直接采用。
    expect(body.models).toContain('test-model');
    expect(body.models).toContain('test-model-2');
  });

  it('returns admin overview with the recorded usage', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/llm-gateway/admin/overview',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { summary: { requests: number; amount: number } };
    expect(body.summary.requests).toBeGreaterThanOrEqual(2);
    expect(body.summary.amount).toBeGreaterThanOrEqual(2);
  });

  it('rejects a platform token that lacks the gateway scope', async () => {
    const prisma = getPrisma();
    const plaintext = `sp_noscope_${randomUUID()}`;
    const token = await prisma.apiToken.create({
      data: {
        userId,
        name: 'no-scope',
        keyPrefix: `${plaintext.slice(0, 12)}…`,
        keyHash: sha256(plaintext),
        scopes: [],
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${plaintext}` },
      payload: { model: 'test-model', messages: [] },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('insufficient_scope');
    await prisma.apiToken.delete({ where: { id: token.id } });
  });

  it('rejects a token whose IP allowlist excludes the caller', async () => {
    const prisma = getPrisma();
    const plaintext = `sp_ip_${randomUUID()}`;
    const token = await prisma.apiToken.create({
      data: {
        userId,
        name: 'ip-guard',
        keyPrefix: `${plaintext.slice(0, 12)}…`,
        keyHash: sha256(plaintext),
        scopes: ['llm-gateway.use'],
        ipAllowlist: ['10.0.0.0/8'],
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${plaintext}` },
      payload: { model: 'test-model', messages: [] },
      remoteAddress: '203.0.113.5',
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ip_not_allowed');
    await prisma.apiToken.delete({ where: { id: token.id } });
  });

  it('rejects a token when its holder lost the gateway permission', async () => {
    const prisma = getPrisma();
    const plaintext = `sp_viewer_${randomUUID()}`;
    const token = await prisma.apiToken.create({
      data: {
        userId: viewerId,
        name: 'viewer',
        keyPrefix: `${plaintext.slice(0, 12)}…`,
        keyHash: sha256(plaintext),
        scopes: ['llm-gateway.use'],
      },
    });
    // 策略行直接写引擎物理表（视图层已不暴露内核模型）。
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${POLICY_TABLE}"
         ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
          "created_at", "updated_at", "f_apiTokenId", "f_quotaUsed")
       VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
               now(), now(), $3, $4)`,
      token.id,
      JSON.stringify({
        apiTokenId: token.id,
        models: [],
        rpmLimit: 0,
        concurrencyLimit: 0,
        quotaLimit: null,
        quotaUsed: 0,
      }),
      token.id,
      0,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${plaintext}` },
      payload: { model: 'test-model', messages: [] },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('permission_revoked');
  });

  it('falls back to a legacy gateway key during the merge window', async () => {
    const prisma = getPrisma();
    const plaintext = `sk-sp-legacy_${randomUUID()}`;
    const legacyId = `legacy-${randomUUID()}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${LEGACY_TABLE}"
         ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
          "created_at", "updated_at", "f_keyHash", "f_userId", "f_status", "f_quotaUsed", "f_lastUsedAt")
       VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
               now(), now(), $3, $4, $5, $6, $7)`,
      legacyId,
      JSON.stringify({
        userId,
        name: 'legacy',
        keyPrefix: `${plaintext.slice(0, 12)}…`,
        keyHash: sha256(plaintext),
        status: 'ACTIVE',
        models: ['test-model'],
        rpmLimit: 0,
        concurrencyLimit: 0,
        quotaLimit: null,
        quotaUsed: 0,
        expiresAt: null,
        lastUsedAt: null,
      }),
      sha256(plaintext),
      userId,
      'ACTIVE',
      0,
      null,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${plaintext}` },
      payload: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
  });
});
