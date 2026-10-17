import { createHash } from 'node:crypto';
import { advanceBackground, sweepAgents } from '../../src/agent/background.ts';
import { mcpRoutes } from '../../src/mcp/routes.ts';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { LlmCompletionResult, LlmProvider, McpCapability } from '@stackpanel/sdk';
import { isPluginError } from '@stackpanel/sdk';
import { getRedis, closeRedis } from '@stackpanel/db';
import { useRedisState } from '../../src/state/index.ts';
import { RedisStateService } from '../../src/state/redis-state-service.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { agentRoutes } from '../../src/routes/agent.ts';
import { adminAgentModelRoutes } from '../../src/routes/admin/agent-model.ts';
import { generateApiToken } from '../../src/lib/api-tokens.ts';
import { requireAuth } from '../../src/plugins/auth.ts';
import { KernelNotificationsService } from '../../src/notifications/notifications-service.ts';
import { EventEmitterEventBus } from '../../src/plugins/events.ts';
import { getSessionStore } from '../../src/auth/session-store.ts';
import { releaseTokenQuota } from '../../src/lib/open-api-guard.ts';

const db = getPrisma();
const app = Fastify();
let script: LlmCompletionResult[] = [];
let calls = 0;
let effects = 0;
let block: (() => Promise<void>) | undefined;
const capability: McpCapability = {
  id: 'fixture.write',
  method: 'POST',
  path: '/api/v1/fixture',
  scope: null,
  summary: 'Create fixture',
  mutating: true,
};
const answer = (tool = false): LlmCompletionResult => ({
  model: 'test-model',
  stopReason: tool ? 'tool_calls' : 'stop',
  parts: tool
    ? [{ type: 'tool-call', id: 'c1', name: 'fixture_write', arguments: '{}' }]
    : [{ type: 'text', text: '已完成' }],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  costMinor: 1,
});
const provider: LlmProvider = {
  id: 'fixture',
  name: 'Fixture',
  listModels: async () => [{ id: 'test-model', label: '测试模型', supportsTools: true }],
  complete: async () => {
    calls++;
    await block?.();
    const result = script.shift();
    if (!result) throw new Error('empty script');
    return result;
  },
};
let userId: string;
let adminId: string;
let session: string;
let adminSession: string;
let token: string;
let sibling: string;
let tokenId: string;
let keyIndex = 0;
const suiteId = Date.now();
const headers = () => ({
  authorization: `Bearer ${token}`,
  'idempotency-key': `agent-case-${suiteId}-${++keyIndex}`,
});
const create = () =>
  app.inject({
    method: 'POST',
    url: '/api/v1/agent/runs',
    headers: headers(),
    payload: { objective: '测试任务', model: 'test-model' },
  });

beforeAll(async () => {
  if (process.env.AGENT_TEST_REDIS_URL)
    useRedisState(await getRedis(process.env.AGENT_TEST_REDIS_URL));
  await app.register(cookie);
  // Real auth, PostgreSQL persistence and event/notification services; only inference is scripted.
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
    if (isPluginError(error))
      return reply.code(error.status).send({ code: error.code, detail: error.message });
    return reply.code(500).send({ error: String(error) });
  });
  app.post('/api/v1/fixture', { preHandler: requireAuth }, async () => {
    effects++;
    return { ok: true };
  });
  await app.register(agentRoutes);
  await app.register(mcpRoutes);
  await app.register(adminAgentModelRoutes);
  await app.ready();
  const permission = await db.permission.upsert({
    where: { key: 'platform.admin' },
    create: { key: 'platform.admin', name: '管理员' },
    update: {},
  });
  const group = await db.permissionGroup.create({
    data: {
      name: `Agent test admin ${suiteId}`,
      permissions: { create: { permissionId: permission.id } },
    },
  });
  const user = await db.user.create({ data: { email: `agent_${suiteId}@example.test` } });
  userId = user.id;
  const admin = await db.user.create({
    data: {
      email: `agent_admin_${suiteId}@example.test`,
      groups: { create: { groupId: group.id } },
    },
  });
  adminId = admin.id;
  session = await getSessionStore().create(userId);
  adminSession = await getSessionStore().create(adminId);
  for (const name of ['original', 'sibling']) {
    const generated = generateApiToken();
    const row = await db.apiToken.create({
      data: {
        userId,
        name,
        keyHash: generated.keyHash,
        keyPrefix: generated.keyPrefix,
        scopes: ['mcp.write'],
      },
    });
    if (name === 'original') {
      token = generated.plaintext;
      tokenId = row.id;
    } else sibling = generated.plaintext;
  }
  await db.setting.upsert({
    where: { key: 'agent.enabled' },
    create: { key: 'agent.enabled', value: true },
    update: { value: true },
  });
});
afterAll(async () => {
  await app.close();
  await db.$disconnect();
  if (process.env.AGENT_TEST_REDIS_URL) await closeRedis();
});

describe('Agent HTTP + PostgreSQL reliability', () => {
  it('returns status/models without exposing model secrets', async () => {
    const res = await app.inject({
      url: '/api/v1/agent/status',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.json()).toMatchObject({
      enabled: true,
      modelConfigured: true,
      provider: { id: 'fixture' },
    });
    const models = await app.inject({
      url: '/api/v1/agent/models',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(models.json().models[0].id).toBe('test-model');
  });
  it('requires durable creation idempotency and detects mismatched payloads', async () => {
    script = [answer()];
    const request = {
      method: 'POST' as const,
      url: '/api/v1/agent/runs',
      headers: headers(),
      payload: { objective: '幂等任务', model: 'test-model' },
    };
    const first = await app.inject(request);
    expect(first.statusCode, first.body).toBe(201);
    const count = calls;
    const replay = await app.inject(request);
    expect(replay.json().run.id).toBe(first.json().run.id);
    expect(calls).toBe(count);
    const conflict = await app.inject({
      ...request,
      payload: { ...request.payload, objective: '另一任务' },
    });
    expect(conflict.statusCode).toBe(409);
    const missing = await app.inject({ ...request, headers: { authorization: `Bearer ${token}` } });
    expect(missing.statusCode).toBe(400);
  });
  it('separates human decision from execution and rejects session/sibling-key resume', async () => {
    script = [answer(true), answer()];
    const first = await create();
    expect(first.statusCode, first.body).toBe(201);
    const run = first.json().run;
    expect(run.status).toBe('WAITING_APPROVAL');
    const approval = await db.agentApproval.findFirstOrThrow({ where: { runId: run.id } });
    const before = effects;
    const decided = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/approvals/${approval.id}/decide`,
      headers: { authorization: `Bearer ${session}` },
      payload: { approve: true },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(effects).toBe(before);
    for (const credential of [session, sibling]) {
      const refused = await app.inject({
        method: 'POST',
        url: `/api/v1/agent/runs/${run.id}/resume`,
        headers: { authorization: `Bearer ${credential}` },
      });
      expect([400, 403]).toContain(refused.statusCode);
    }
    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/runs/${run.id}/resume`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json().run.status).toBe('DONE');
    expect(effects).toBe(before + 1);
    expect(
      await db.notification.count({ where: { userId, type: 'agent.approval.decided' } }),
    ).toBeGreaterThan(0);
  });
  it('atomically accepts only one of two conflicting approval decisions', async () => {
    script = [answer(true)];
    const run = (await create()).json().run;
    const approval = await db.agentApproval.findFirstOrThrow({ where: { runId: run.id } });
    const results = await Promise.all(
      [true, false].map((approve) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/agent/approvals/${approval.id}/decide`,
          headers: { authorization: `Bearer ${session}` },
          payload: { approve },
        }),
      ),
    );
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
  });
  it('allows administrators alone to configure a finite policy ceiling', async () => {
    const url = `/admin/agent/profiles/${tokenId}`;
    const refused = await app.inject({
      method: 'PUT',
      url,
      headers: { authorization: `Bearer ${session}` },
      payload: {},
    });
    expect(refused.statusCode).toBe(403);
    const accepted = await app.inject({
      method: 'PUT',
      url,
      headers: { authorization: `Bearer ${adminSession}` },
      payload: { maxSteps: 5 },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    script = [answer(true)];
    const run = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/runs',
      headers: headers(),
      payload: { objective: '受限任务', model: 'test-model', autonomy: 'act', maxSteps: 200 },
    });
    expect(run.json().run.status).toBe('WAITING_APPROVAL');
    const row = await db.agentRun.findUniqueOrThrow({ where: { id: run.json().run.id } });
    expect(row.policy).toMatchObject({ autonomy: 'read', maxSteps: 5 });
  });
  it('keeps cancellation final while inference is in flight', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    block = async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    script = [answer(true)];
    const request = create();
    await started;
    const row = await db.agentRun.findFirstOrThrow({
      where: { actorId: userId },
      orderBy: { createdAt: 'desc' },
    });
    const before = effects;
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/runs/${row.id}/cancel`,
      headers: { authorization: `Bearer ${session}` },
    });
    expect(cancelled.statusCode).toBe(200);
    release();
    block = undefined;
    expect((await request).json().run.status).toBe('CANCELLED');
    expect(effects).toBe(before);
  });
  it('keeps history and cancellation available while execution is disabled', async () => {
    script = [answer()];
    const run = (await create()).json().run;
    await db.setting.update({ where: { key: 'agent.enabled' }, data: { value: false } });
    try {
      const history = await app.inject({
        url: `/api/v1/agent/runs/${run.id}`,
        headers: { authorization: `Bearer ${session}` },
      });
      expect(history.statusCode).toBe(200);
      const anotherOwner = await app.inject({
        url: `/api/v1/agent/runs/${run.id}`,
        headers: { authorization: `Bearer ${adminSession}` },
      });
      expect(anotherOwner.statusCode).toBe(404);
      expect((await create()).statusCode).toBe(403);
    } finally {
      await db.setting.update({ where: { key: 'agent.enabled' }, data: { value: true } });
    }
  });
  it('does not advance a run with a revoked original key', async () => {
    const generated = generateApiToken();
    const revoked = await db.apiToken.create({
      data: {
        userId,
        name: 'revoked fixture',
        keyHash: generated.keyHash,
        keyPrefix: generated.keyPrefix,
        scopes: ['mcp.write'],
      },
    });
    script = [answer(true)];
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/runs',
      headers: { ...headers(), authorization: `Bearer ${generated.plaintext}` },
      payload: { objective: '撤销凭证', model: 'test-model' },
    });
    expect(result.statusCode, result.body).toBe(201);
    const run = result.json().run;
    await db.apiToken.update({ where: { id: revoked.id }, data: { status: 'REVOKED' } });
    const before = calls;
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/runs/${run.id}/resume`,
      headers: { authorization: `Bearer ${generated.plaintext}` },
    });
    expect(denied.statusCode).toBe(401);
    expect(calls).toBe(before);
  });
  it('deduplicates concurrent creation requests using the database unique constraint', async () => {
    script = [answer()];
    const before = calls;
    const request = {
      method: 'POST' as const,
      url: '/api/v1/agent/runs',
      headers: headers(),
      payload: { objective: '并发创建', model: 'test-model' },
    };
    const results = await Promise.all([app.inject(request), app.inject(request)]);
    expect(
      results.every((res) => res.statusCode < 300),
      results.map((res) => res.body).join(' '),
    ).toBe(true);
    expect(results[0]?.json().run.id).toBe(results[1]?.json().run.id);
    expect(calls).toBe(before + 1);
  });
  it('selects a tool-capable provider model when no explicit model is configured', async () => {
    script = [answer()];
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/runs',
      headers: headers(),
      payload: { objective: '自动选模型' },
    });
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json().run.model).toBe('test-model');
  });
  it('rejects a second advance while a model call holds the account lease', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    block = async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    script = [answer()];
    const request = create();
    await started;
    try {
      const run = await db.agentRun.findFirstOrThrow({
        where: { actorId: userId },
        orderBy: { createdAt: 'desc' },
      });
      const busy = await app.inject({
        method: 'POST',
        url: `/api/v1/agent/runs/${run.id}/resume`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(busy.statusCode, busy.body).toBe(409);
      expect(busy.json().code).toBe('agent.run.busy');
      if (process.env.AGENT_TEST_REDIS_URL) {
        // A separate service instance sees the actual Redis lease held by the runtime.
        const peer = new RedisStateService(await getRedis(process.env.AGENT_TEST_REDIS_URL));
        expect(
          await peer.acquireLease([{ key: `agent:actor:${userId}`, limit: 1 }], 1000),
        ).toBeNull();
      }
    } finally {
      release();
      block = undefined;
      await request;
    }
  });
  it('denies further inference when the daily step ceiling is exhausted', async () => {
    await db.agentProfile.update({ where: { apiTokenId: tokenId }, data: { dailySteps: 1 } });
    const count = calls;
    script = [answer()];
    const result = await create();
    expect(result.json().run.status).toBe('FAILED');
    expect(calls).toBe(count);
  });
});

describe('Agent complete plan boundaries', () => {
  beforeAll(async () => { await db.agentProfile.update({where:{apiTokenId:tokenId},data:{dailySteps:10000}}); });
  const auth = () => ({ authorization: `Bearer ${session}` });
  const admin = () => ({ authorization: `Bearer ${adminSession}` });
  const background = () => app.inject({method:'POST',url:'/api/v1/agent/runs',headers:headers(),payload:{objective:'后台任务',model:'test-model',execution:'background'}});
  it('advances a background run once across racing workers and removes its encrypted credential',async()=>{
    script=[answer()]; const before=calls; const created=await background();
    expect(created.statusCode,created.body).toBe(202); const id=created.json().run.id;
    const stored=await db.secret.findUniqueOrThrow({where:{key:`agent.dispatch.${id}`}});
    expect(stored.ciphertext).not.toContain(token);
    await Promise.all([advanceBackground(app,id),advanceBackground(app,id)]);
    expect((await db.agentRun.findUniqueOrThrow({where:{id}})).status).toBe('DONE');
    expect(calls).toBe(before+1);expect(await db.agentDispatch.count({where:{runId:id}})).toBe(0);
    expect(await db.secret.count({where:{key:`agent.dispatch.${id}`}})).toBe(0);
  });
  it('expires background authorization without invoking inference',async()=>{
    const created=await background(); const id=created.json().run.id; const before=calls;
    await db.agentDispatch.update({where:{runId:id},data:{expiresAt:new Date(0)}});
    await advanceBackground(app,id);
    expect((await db.agentRun.findUniqueOrThrow({where:{id}})).status).toBe('FAILED'); expect(calls).toBe(before);
  });
  it('background work rechecks revocation of the original key',async()=>{
    const created=await background();const id=created.json().run.id;const before=calls;
    await db.apiToken.update({where:{id:tokenId},data:{status:'DISABLED'}});
    await advanceBackground(app,id);
    expect((await db.agentRun.findUniqueOrThrow({where:{id}})).status).toBe('FAILED');expect(calls).toBe(before);
    const generated=generateApiToken(); const replacement=await db.apiToken.create({data:{userId,name:'replacement',keyHash:generated.keyHash,keyPrefix:generated.keyPrefix,scopes:['mcp.write']}}); token=generated.plaintext;tokenId=replacement.id;
  });
  it('reconstructs a terminal notice missing after a crash',async()=>{
    const run=await db.agentRun.create({data:{actorId:userId,tokenId,objective:'失联通知',status:'DONE',endedAt:new Date()}});
    await sweepAgents(app);
    expect(await db.agentDelivery.count({where:{runId:run.id}})).toBe(1);
    await sweepAgents(app);
    expect(await db.agentDelivery.count({where:{runId:run.id}})).toBe(1);
  });
  it('keeps dangerous writes pending even when a profile allows act',async()=>{
    await db.agentProfile.upsert({where:{apiTokenId:tokenId},create:{apiTokenId:tokenId,autonomy:'act'},update:{autonomy:'act'}});
    script=[answer(true)];const before=effects;const created=await create();
    expect(created.json().run.status).toBe('WAITING_APPROVAL');expect(effects).toBe(before);
    const approval=await db.agentApproval.findFirstOrThrow({where:{runId:created.json().run.id}});
    const robotic=await app.inject({method:'POST',url:`/api/v1/agent/approvals/${approval.id}/decide`,headers:{authorization:`Bearer ${token}`},payload:{approve:true}});
    expect(robotic.statusCode,robotic.body).toBe(403);
    await db.agentProfile.update({where:{apiTokenId:tokenId},data:{autonomy:'read'}});
  });
  it('shares a finite step allowance with children and refuses a sibling credential',async()=>{
    const parent=await background();const id=parent.json().run.id;
    script=[answer()];
    const child=await app.inject({method:'POST',url:'/api/v1/agent/runs',headers:headers(),payload:{objective:'子任务',model:'test-model',parentId:id}});
    expect(child.statusCode,child.body).toBe(201);
    const row=await db.agentRun.findUniqueOrThrow({where:{id:child.json().run.id}});expect(row.rootId).toBe(id);expect(row.depth).toBe(1);
    const detail=await app.inject({url:`/api/v1/agent/runs/${id}`,headers:auth()});expect(detail.json().family.length).toBe(2);
    const refused=await app.inject({method:'POST',url:'/api/v1/agent/runs',headers:{authorization:`Bearer ${sibling}`,'idempotency-key':`child-invalid-${suiteId}`},payload:{objective:'越界子任务',model:'test-model',parentId:id}});
    expect(refused.statusCode,refused.body).toBe(409);
    await app.inject({method:'POST',url:`/api/v1/agent/runs/${id}/cancel`,headers:auth(),payload:{}});
  });
  it('starts the shared family clock when a child runs before its queued parent', async () => {
    const parent = await background(); const id = parent.json().run.id;
    script = [answer()];
    const makeChild = () => app.inject({method:'POST',url:'/api/v1/agent/runs',headers:headers(),payload:{objective:'共享时间子任务',model:'test-model',parentId:id}});
    const first = await makeChild(); expect(first.json().run.status).toBe('DONE');
    expect((await db.agentRun.findUniqueOrThrow({where:{id}})).startedAt).not.toBeNull();
    await db.agentRun.update({where:{id},data:{startedAt:new Date(0)}});
    const count = calls; const second = await makeChild();
    expect(second.json().run.status).toBe('FAILED'); expect(calls).toBe(count);
    await app.inject({method:'POST',url:`/api/v1/agent/runs/${id}/cancel`,headers:auth(),payload:{}});
  });
  it('rejects changed external tools and invalid arguments before sending any traffic',async()=>{
    const permission=await db.permission.upsert({where:{key:'mcp.external.fixture'},create:{key:'mcp.external.fixture',name:'fixture'},update:{}});
    const group=await db.permissionGroup.create({data:{name:`External ${suiteId}`,permissions:{create:{permissionId:permission.id}},members:{create:{userId}}}});
    expect(group.id).toBeTruthy();
    await db.agentMcpServer.upsert({where:{id:'fixture'},create:{id:'fixture',name:'fixture',url:'https://example.com/mcp',enabled:true,revision:2,tools:[{name:'inspect',description:'test',inputSchema:{type:'object',required:['value'],properties:{value:{type:'number'}},additionalProperties:false},readOnly:true,destructive:false}]},update:{revision:2}});
    const stale=await app.inject({method:'POST',url:'/api/v1/agent/external/fixture/v1/tools/inspect',headers:auth(),payload:{value:1}});
    expect(stale.statusCode,stale.body).toBe(409);
    const invalid=await app.inject({method:'POST',url:'/api/v1/agent/external/fixture/v2/tools/inspect',headers:auth(),payload:{value:'bad'}});
    expect(invalid.statusCode,invalid.body).toBe(422);
  });
  it('encrypts per-user MCP secrets and never echoes them',async()=>{
    const saved=await app.inject({method:'PUT',url:'/api/v1/agent/mcp-servers/fixture/credential',headers:auth(),payload:{token:'remote-secret-sensitive'}});
    expect(saved.statusCode,saved.body).toBe(200);expect(saved.body).not.toContain('remote-secret-sensitive');
    const stored=await db.secret.findUniqueOrThrow({where:{key:`agent.mcp.fixture.${userId}`}});expect(stored.ciphertext).not.toContain('remote-secret-sensitive');
  });
  it('does not expose administrator settings to ordinary users',async()=>{
    for(const url of ['/admin/agent/actions','/admin/agent/oauth-clients','/admin/agent/mcp-servers','/admin/agent/runs']) expect((await app.inject({url,headers:auth()})).statusCode).toBe(403);
  });
  it('returns validation failures without echoing submitted secrets',async()=>{
    const response=await app.inject({method:'PUT',url:'/admin/agent/oauth-clients/bad',headers:admin(),payload:{name:'bad',redirectUris:['http://evil.test/callback']}});
    expect(response.statusCode,response.body).toBe(422);
  });

  const verifier='a'.repeat(43);
  const authorization=()=>({client_id:`fixture-${suiteId}`,redirect_uri:'https://client.example/callback',response_type:'code',state:'state-with-entropy-123456',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:'https://api.stackpanel.test/mcp',scope:''});
  let refresh:string;let access:string;let clientId:string;
  it('publishes discovery metadata and an authentication challenge',async()=>{
    const meta=await app.inject({url:'/.well-known/oauth-protected-resource/mcp'});expect(meta.json().resource).toBe('https://api.stackpanel.test/mcp');
    const response=await app.inject({method:'POST',url:'/mcp',payload:{jsonrpc:'2.0',id:'1',method:'initialize'}});expect(response.statusCode).toBe(401);expect(response.headers['www-authenticate']).toContain('resource_metadata=');
  });
  it('requires human consent, exact redirects and valid PKCE before exchanging a one-use code',async()=>{
    clientId=authorization().client_id;
    const configured=await app.inject({method:'PUT',url:`/admin/agent/oauth-clients/${clientId}`,headers:admin(),payload:{name:'Fixture OAuth',redirectUris:[authorization().redirect_uri]}});expect(configured.statusCode,configured.body).toBe(200);
    const malicious=await app.inject({method:'POST',url:'/api/v1/agent/oauth/authorize',headers:auth(),payload:{...authorization(),redirect_uri:'https://evil.example/callback'}});expect(malicious.statusCode).toBe(400);
    const nonHuman=await app.inject({method:'POST',url:'/api/v1/agent/oauth/authorize',headers:{authorization:`Bearer ${token}`},payload:authorization()});expect(nonHuman.statusCode).toBe(403);
    const consent=await app.inject({method:'POST',url:'/api/v1/agent/oauth/authorize',headers:auth(),payload:authorization()});expect(consent.statusCode,consent.body).toBe(200);
    const code=new URL(consent.json().redirectUri).searchParams.get('code');
    const request={grant_type:'authorization_code',client_id:clientId,code,redirect_uri:authorization().redirect_uri,code_verifier:verifier,resource:authorization().resource};
    expect((await app.inject({method:'POST',url:'/oauth/token',payload:{...request,code_verifier:'b'.repeat(43)}})).statusCode).toBe(400);
    const issued=await app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams(request as Record<string,string>).toString()});expect(issued.statusCode,issued.body).toBe(200);
    refresh=issued.json().refresh_token;access=issued.json().access_token;
    expect(issued.headers['cache-control']).toBe('no-store');expect((await app.inject({method:'POST',url:'/oauth/token',payload:request})).statusCode).toBe(400);
  });
  it('accepts OAuth credentials at MCP and refuses direct platform API reuse',async()=>{
    const mcp=await app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${access}`},payload:{jsonrpc:'2.0',id:'1',method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}}}});expect(mcp.statusCode,mcp.body).toBe(200);
    const tool = await app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${access}`},payload:{jsonrpc:'2.0',id:'tool',method:'tools/call',params:{name:'agent_run_list',arguments:{}}}});
    expect(tool.statusCode,tool.body).toBe(200); expect(tool.json().result.isError).not.toBe(true);
    expect((await app.inject({url:'/api/v1/agent/credential',headers:{authorization:`Bearer ${access}`}})).statusCode).toBe(401);
  });
  it('rotates refresh tokens and revokes the full family on replay',async()=>{
    const oldRefresh=refresh;const rotated=await app.inject({method:'POST',url:'/oauth/token',payload:{grant_type:'refresh_token',client_id:clientId,refresh_token:refresh}});expect(rotated.statusCode,rotated.body).toBe(200);
    access=rotated.json().access_token;refresh=rotated.json().refresh_token;
    expect((await app.inject({method:'POST',url:'/oauth/token',payload:{grant_type:'refresh_token',client_id:clientId,refresh_token:oldRefresh}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${access}`},payload:{jsonrpc:'2.0',id:'1',method:'tools/list'}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/oauth/token',payload:{grant_type:'refresh_token',client_id:clientId,refresh_token:refresh}})).statusCode).toBe(400);
  });
  it('revokes the refresh family after concurrent replay and disables active client credentials', async () => {
    const issue = async () => {
      const consent = await app.inject({method:'POST',url:'/api/v1/agent/oauth/authorize',headers:auth(),payload:authorization()});
      expect(consent.statusCode,consent.body).toBe(200);
      const issued = await app.inject({method:'POST',url:'/oauth/token',payload:{grant_type:'authorization_code',client_id:clientId,code:new URL(consent.json().redirectUri).searchParams.get('code'),redirect_uri:authorization().redirect_uri,code_verifier:verifier}});
      expect(issued.statusCode,issued.body).toBe(200);return issued.json();
    };
    const issued = await issue();
    const payload = {grant_type:'refresh_token',client_id:clientId,refresh_token:issued.refresh_token};
    const raced = await Promise.all([app.inject({method:'POST',url:'/oauth/token',payload}),app.inject({method:'POST',url:'/oauth/token',payload})]);
    expect(raced.map(row=>row.statusCode).sort()).toEqual([200,400]);
    const winner = raced.find(row=>row.statusCode===200);
    if (!winner) throw new Error('缺少刷新响应');
    const check = (accessToken:string) => app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${accessToken}`},payload:{jsonrpc:'2.0',id:'1',method:'tools/list'}});
    expect((await check(winner.json().access_token)).statusCode).toBe(401);
    const fresh = await issue();
    const disabled = await app.inject({method:'PUT',url:`/admin/agent/oauth-clients/${clientId}`,headers:admin(),payload:{name:'Fixture OAuth',redirectUris:[authorization().redirect_uri],enabled:false}});
    expect(disabled.statusCode,disabled.body).toBe(200);
    expect((await check(fresh.access_token)).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/oauth/token',payload:{grant_type:'refresh_token',client_id:clientId,refresh_token:fresh.refresh_token}})).statusCode).toBe(400);
  });
  it('replays a completed inference journal without paying a second time',async()=>{
    const {journaledProvider}=await import('../../src/agent/metering.ts');const {DEFAULT_AGENT_POLICY}=await import('../../src/lib/agent-policy.ts');
    const run=await db.agentRun.create({data:{actorId:userId,tokenId,objective:'计费重放'}});const wrapped=journaledProvider(provider,run.id,userId,DEFAULT_AGENT_POLICY);script=[answer()];const before=calls;
    const req={model:'test-model',messages:[]};const options={callId:`${run.id}:model1`,actorId:userId,runId:run.id};
    expect(await wrapped.complete(req,options)).toEqual(await wrapped.complete(req,options));expect(calls).toBe(before+1);
    await expect(wrapped.complete({...req,model:'changed'},options)).rejects.toMatchObject({code:'agent.model_call_conflict'});
  });
  it('fails closed on an inference with an unknown result',async()=>{
    const {journaledProvider}=await import('../../src/agent/metering.ts');const {DEFAULT_AGENT_POLICY}=await import('../../src/lib/agent-policy.ts');
    const run=await db.agentRun.create({data:{actorId:userId,tokenId,objective:'结果不明'}});const wrapped=journaledProvider(provider,run.id,userId,DEFAULT_AGENT_POLICY);script=[];const before=calls;const req={model:'test-model',messages:[]};const opts={callId:`${run.id}:model1`,actorId:userId,runId:run.id};
    await expect(wrapped.complete(req,opts)).rejects.toThrow();await expect(wrapped.complete(req,opts)).rejects.toMatchObject({code:'agent.model_result_unknown'});expect(calls).toBe(before+1);
  });
});

it.runIf(Boolean(process.env.AGENT_TEST_SANDBOX_IMAGE))('runs a real digest-pinned sandbox without network/root/write access',async()=>{
  const { runSandbox } = await import('../../src/agent/actions.ts');
  const result=await runSandbox({name:'fixture',enabled:true,image:String(process.env.AGENT_TEST_SANDBOX_IMAGE),timeoutSeconds:30,inputSchema:{type:'object'},argv:['node','-e',`const fs=require('fs'),os=require('os'); let readOnly=false; try{fs.writeFileSync('/escape','bad')}catch{readOnly=true}; process.stdout.write(JSON.stringify({uid:process.getuid(),readOnly,interfaces:Object.keys(os.networkInterfaces())}));`]},{});
  expect(JSON.parse(result.stdout)).toEqual({uid:65534,readOnly:true,interfaces:['lo']});
},15000);

it('applies a root step ceiling across independently requested child runs',async()=>{
  const parent=await app.inject({method:'POST',url:'/api/v1/agent/runs',headers:headers(),payload:{objective:'共享额度',model:'test-model',execution:'background',maxSteps:1}});expect(parent.statusCode,parent.body).toBe(202);
  const id=parent.json().run.id;script=[answer()];
  const spawn=()=>app.inject({method:'POST',url:'/api/v1/agent/runs',headers:headers(),payload:{objective:'受限子任务',model:'test-model',parentId:id,maxSteps:50}});
  const child=await spawn();expect(child.json().run.status).toBe('DONE');const before=calls;
  const second=await spawn();expect(second.json().run.status).toBe('FAILED');expect(calls).toBe(before);
  await app.inject({method:'POST',url:`/api/v1/agent/runs/${id}/cancel`,headers:{authorization:`Bearer ${session}`},payload:{}});
});
it('retains and retries a failed notification intent without duplicating its inbox record',async()=>{
  const {notifyAgent,retryAgentNotices}=await import('../../src/notifications/agent-notifications.ts');
  const run=await db.agentRun.create({data:{actorId:userId,tokenId,objective:'通知故障'}});
  await notifyAgent({upsert:async()=>{throw new Error('temporary failure');}} as never,userId,run.id,{key:'retry',type:'agent.test',title:'测试通知',body:'测试'});
  const delivery=await db.agentDelivery.findFirstOrThrow({where:{runId:run.id}});expect(delivery.deliveredAt).toBeNull();
  await db.agentDelivery.update({where:{id:delivery.id},data:{nextAttemptAt:new Date(0)}});
  await retryAgentNotices(app.notifications);await retryAgentNotices(app.notifications);
  expect((await db.agentDelivery.findUniqueOrThrow({where:{id:delivery.id}})).deliveredAt).not.toBeNull();
  expect(await db.notification.count({where:{userId,dedupeKey:`agent:${run.id}:retry`}})).toBe(1);
});
