import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmCompletionResult, LlmProvider, McpCapability } from '@stackpanel/sdk';
import { isPluginError } from '@stackpanel/sdk';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { getSessionStore } from '../../src/auth/session-store.ts';
import { agentRoutes } from '../../src/routes/agent.ts';
import { adminAgentModelRoutes } from '../../src/routes/admin/agent-model.ts';
import { requireAuth } from '../../src/plugins/auth.ts';
import { KernelNotificationsService } from '../../src/notifications/notifications-service.ts';
import { EventEmitterEventBus } from '../../src/plugins/events.ts';
import { releaseTokenQuota } from '../../src/lib/open-api-guard.ts';
import { LLM_CONFIG_SETTING_KEY, LLM_DEFAULT_MODEL_SETTING_KEY } from '../../src/lib/llm-provider.ts';

/**
 * B-1/B-2/B-3 的回归：抽屉能真的跑起来、发起任务不再要手贴 Key、
 * 「测试连接」必须能识别不支持 tool calling 的中转。
 *
 * 只把推理本身脚本化（`LlmProvider.complete`），鉴权、权限、额度、落库、
 * 审计全部走真实实现——这正是这些缺陷当初溜过去的地方：后端一切正常，
 * 前端从不发起运行。
 */

const db = getPrisma();
const app = Fastify();
const suite = Date.now();

/** 记录每次推理请求带的 tool 列表，用来断言「探测真的带了 dummy tool」。 */
let seenTools: Array<Array<{ name: string }>> = [];
let script: LlmCompletionResult[] = [];
let toolCallsSeen = 0;

const answer = (): LlmCompletionResult => ({
  model: 'test-model',
  stopReason: 'stop',
  parts: [{ type: 'text', text: '已完成' }],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  costMinor: 1,
});

const toolAnswer = (): LlmCompletionResult => ({
  model: 'test-model',
  stopReason: 'tool_calls',
  parts: [{ type: 'tool-call', id: 'probe-1', name: 'stackpanel_probe_echo', arguments: '{"probe":"ping"}' }],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  costMinor: 0,
});

const capability: McpCapability = {
  id: 'fixture.read',
  method: 'GET',
  path: '/api/v1/fixture',
  scope: null,
  summary: 'Read fixture',
  mutating: false,
};

const provider: LlmProvider = {
  id: 'fixture',
  name: 'Fixture',
  listModels: async () => [{ id: 'test-model', label: '测试模型', supportsTools: true }],
  complete: async (request) => {
    seenTools.push((request.tools ?? []).map((tool) => ({ name: tool.name })));
    const result = script.shift();
    if (!result) throw new Error('empty script');
    if (result.parts.some((part) => part.type === 'tool-call')) toolCallsSeen += 1;
    return result;
  },
};

let userId: string;
let groupId: string;
let session: string;

beforeAll(async () => {
  await app.register(cookie);
  app.decorate('pluginRuntime', {
    listCapabilities: () => [capability],
    getExtensions: () => [provider],
    scopeGovernance: () => ({}),
  } as never);
  app.decorate(
    'notifications',
    new KernelNotificationsService({ db, events: new EventEmitterEventBus() }),
  );
  app.addHook('onResponse', async (request) => {
    await releaseTokenQuota(request);
  });
  app.setErrorHandler((error, _request, reply) => {
    if (isPluginError(error)) return reply.code(error.status).send({ code: error.code, detail: error.message });
    return reply.code(500).send({ error: String(error) });
  });
  app.get('/api/v1/fixture', { preHandler: requireAuth }, async () => ({ ok: true }));
  await app.register(agentRoutes);
  await app.register(adminAgentModelRoutes);
  await app.ready();

  // 管理员身份：`/admin/agent/*` 与「本机自测」都要求 platform.admin。
  const permission = await db.permission.upsert({
    where: { key: 'platform.admin' },
    create: { key: 'platform.admin', name: '管理员' },
    update: {},
  });
  const group = await db.permissionGroup.create({
    data: {
      name: `Workspace probe ${suite}`,
      permissions: { create: { permissionId: permission.id } },
    },
  });
  const user = await db.user.create({
    data: {
      email: `workspace_${suite}@example.test`,
      groups: { create: { groupId: group.id } },
    },
  });
  groupId = group.id;
  userId = user.id;
  session = await getSessionStore().create(userId);
  await db.setting.upsert({
    where: { key: 'agent.enabled' },
    create: { key: 'agent.enabled', value: { enabled: true } },
    update: { value: { enabled: true } },
  });
  await db.setting.upsert({
    where: { key: LLM_DEFAULT_MODEL_SETTING_KEY },
    create: { key: LLM_DEFAULT_MODEL_SETTING_KEY, value: { model: 'test-model' } },
    update: { value: { model: 'test-model' } },
  });
});

afterAll(async () => {
  await db.agentStep.deleteMany({ where: { run: { actorId: userId } } });
  await db.agentRun.deleteMany({ where: { actorId: userId } });
  await db.apiToken.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.permissionGroup.deleteMany({ where: { id: groupId } });
  await db.setting.deleteMany({ where: { key: LLM_CONFIG_SETTING_KEY } });
  await app.close();
});

const auth = () => ({ authorization: `Bearer ${session}` });
const createKey = () => `workspace-${randomUUID()}`;

describe('workspace runs without a hand-pasted API key (B-1/B-2)', () => {
  it('accepts a run for a signed-in session and records who owns it', async () => {
    script = [answer()];
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/workspace/runs',
      headers: { ...auth(), 'idempotency-key': createKey() },
      payload: { objective: '统计插件数量', model: 'test-model' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const run = res.json().run as { id: string; status: string; error?: string };
    expect(run.status, run.error).toBe('DONE');
    const row = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.actorId).toBe(userId);
    // 运行必须挂在会话代签的短期 run token 上（audience 才是权限边界）。
    const token = await db.apiToken.findUniqueOrThrow({ where: { id: row.tokenId } });
    expect(token.audience).toBe('agent-run');
    expect(token.userId).toBe(userId);
  });

  it('rejects a session run when the operation switch is off', async () => {
    await db.setting.update({ where: { key: 'agent.enabled' }, data: { value: { enabled: false } } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/workspace/runs',
      headers: { ...auth(), 'idempotency-key': createKey() },
      payload: { objective: '关闭后不得执行', model: 'test-model' },
    });
    // 开关关闭走统一的 `agent.disabled`（403），与 `/runs` 入口一致。
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('agent.disabled');
    await db.setting.update({ where: { key: 'agent.enabled' }, data: { value: { enabled: true } } });
  });

  it('still requires the original key for runs created by an API key', async () => {
    // 用令牌创建（此处直接落库模拟历史数据即可：重点是续跑鉴权）。
    const generated = await import('../../src/lib/api-tokens.ts');
    const minted = generated.generateApiToken();
    const tokenRow = await db.apiToken.create({
      data: { userId, name: 'original', keyHash: minted.keyHash, keyPrefix: minted.keyPrefix, scopes: ['mcp.write'] },
    });
    const run = await db.agentRun.create({
      data: { actorId: userId, tokenId: tokenRow.id, objective: '令牌创建的任务', model: 'test-model' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/runs/${run.id}/resume`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('agent.original_token_required');
  });

  it('mints a short-lived run token that cannot be used outside /api/v1', async () => {
    const minted = await app.inject({ method: 'POST', url: '/api/v1/agent/run-token', headers: auth() });
    expect(minted.statusCode, minted.body).toBe(200);
    const token = minted.json().token as string;
    expect(token.startsWith('sp_')).toBe(true);
    // 令牌本身可用（内核能力路由）。
    expect((await app.inject({ url: '/api/v1/fixture', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    // 但它是 audience=agent-run 的短期凭证，不能被当成通用平台令牌。
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: minted.json().tokenId } });
    expect(row.audience).toBe('agent-run');
    expect(row.expiresAt && row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe('model connectivity probe (B-3)', () => {
  it('probes with a dummy tool and reports tool support', async () => {
    script = [toolAnswer()];
    seenTools = [];
    const before = toolCallsSeen;
    const res = await app.inject({
      method: 'POST',
      url: '/admin/agent/model/test',
      headers: auth(),
      payload: { model: 'test-model' },
    });
    expect(seenTools.at(-1)?.map((tool) => tool.name)).toEqual(['stackpanel_probe_echo']);
    expect(res.json()).toMatchObject({ ok: true, result: 'ok', toolsSupported: true });
    expect(toolCallsSeen).toBe(before + 1);
  });

  it('flags a relay that answers without calling the tool', async () => {
    // 只有文本、没有 tool_call：这正是「中转站不转发 tools」的表现。
    script = [{ ...answer(), parts: [{ type: 'text', text: '当然可以！' }] }];
    const res = await app.inject({
      method: 'POST',
      url: '/admin/agent/model/test',
      headers: auth(),
      payload: { model: 'test-model' },
    });
    expect(res.json()).toMatchObject({ ok: false, result: 'tools_unsupported', toolsSupported: false });
    expect(res.json().message).toBeTruthy();
  });

  it('classifies 401 and 404 instead of a generic failure', async () => {
    script = [];
    const unauthorized = {
      ...provider,
      complete: async () => {
        throw Object.assign(new Error('unauthorized'), { status: 401 });
      },
    };
    const missing = {
      ...provider,
      complete: async () => {
        throw Object.assign(new Error('no such model'), { status: 404 });
      },
    };
    // 用局部实例覆盖扩展点，避免影响其它用例。
    const original = (app as unknown as { pluginRuntime: unknown }).pluginRuntime;
    (app as unknown as { pluginRuntime: unknown }).pluginRuntime = {
      listCapabilities: () => [capability],
      getExtensions: () => [unauthorized],
      scopeGovernance: () => ({}),
    };
    const auth401 = await app.inject({ method: 'POST', url: '/admin/agent/model/test', headers: auth(), payload: {} });
    expect(auth401.json().result).toBe('auth_failed');
    (app as unknown as { pluginRuntime: unknown }).pluginRuntime = {
      listCapabilities: () => [capability],
      getExtensions: () => [missing],
      scopeGovernance: () => ({}),
    };
    const notFound = await app.inject({ method: 'POST', url: '/admin/agent/model/test', headers: auth(), payload: {} });
    expect(notFound.json().result).toBe('not_found');
    (app as unknown as { pluginRuntime: unknown }).pluginRuntime = original;
  });
});
