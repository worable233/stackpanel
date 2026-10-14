import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/** 见 llm-gateway.test.ts：网关包不在内核仓库，未安装时跳过而非变红。 */
const gatewayInstalled = existsSync(
  path.join(process.env['STACKPANEL_DATA_DIR'] ?? '', 'plugins', 'llm-gateway', 'manifest.json'),
);

interface Captured {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

/**
 * 跨协议转换端到端：一个 mock 上游同时扮演 Anthropic Messages 与 Gemini 原生，
 * 验证任意入口协议 → 任意上游协议的请求/响应转换与计费。
 */
describe.skipIf(!dbAvailable || !gatewayInstalled)(
  'llm-gateway protocol conversion (real DB)',
  () => {
  let app: FastifyInstance;
  let upstream: Server;
  let upstreamUrl = '';
  const captured: Captured[] = [];

  const adminEmail = `lgconv_admin_${Date.now()}@example.com`;
  const userEmail = `lgconv_user_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  let userId = '';
  let keyPlaintext = '';

  function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
    });
  }

  beforeAll(async () => {
    upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      captured.push({ path: req.url ?? '', headers: req.headers, body });

      // OpenAI Chat Completions 上游（只认带 /v1 的路径，用于验证上游路径拼接）。
      if (req.url?.startsWith('/v1/chat/completions')) {
        if (body['stream'] === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'chat-x', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi ' }, finish_reason: null }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'chat-x', choices: [{ index: 0, delta: { content: 'from chat' }, finish_reason: 'stop' }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'chat-x', choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl_1',
            object: 'chat.completion',
            model: 'chat-x',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'hi from chat' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
          }),
        );
        return;
      }

      // Anthropic Messages 上游。
      if (req.url?.startsWith('/v1/messages')) {
        if (body['stream'] === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
          );
          res.write(
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          );
          res.write(
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi from "}}\n\n',
          );
          res.write(
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"claude"}}\n\n',
          );
          res.write(
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          );
          res.write(
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
          );
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'hi from claude' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 11, output_tokens: 7 },
          }),
        );
        return;
      }

      // Gemini 原生上游。
      if (req.url?.startsWith('/v1beta/models/')) {
        const payload = {
          candidates: [{ content: { role: 'model', parts: [{ text: 'hi from gemini' }] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 5, totalTokenCount: 18 },
          modelVersion: 'gemini-x',
          responseId: 'g_1',
        };
        if (req.url.includes('streamGenerateContent')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          // 两段文本 + 末帧用量，用于验证跨协议转换时的增量与合并。
          res.write(
            `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'hi from ' }] }, index: 0 }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              candidates: [
                { content: { role: 'model', parts: [{ text: 'gemini' }] }, finishReason: 'STOP', index: 0 },
              ],
              usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 5, totalTokenCount: 18 },
              modelVersion: 'gemini-x',
              responseId: 'g_1',
            })}\n\n`,
          );
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    adminToken = admin.token;
    userToken = user.token;
    userId = user.userId;

    await prisma.plugin.deleteMany({ where: { id: { in: ['store', 'llm-gateway'] } } });
    for (const id of ['store', 'llm-gateway']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/plugins/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
    }

    await prisma.walletAccount.create({ data: { userId, currency: 'CNY', balance: 10_000 } });
    // 开启该用户的 API 计费开关（否则网关会 403）。
    const billing = await app.inject({
      method: 'POST',
      url: '/llm-gateway/billing',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { enabled: true },
    });
    expect(billing.statusCode).toBe(200);
    for (const model of ['conv-model', 'gemini-x', 'chat-model', 'chat-v1base']) {
      await app.inject({
        method: 'POST',
        url: '/llm-gateway/admin/prices',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { model, inputPrice: 100, outputPrice: 200, multiplier: 100 },
      });
    }
    // Anthropic 上游账号。
    await app.inject({
      method: 'POST',
      url: '/llm-gateway/admin/accounts',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'anthropic-upstream',
        baseUrl: upstreamUrl,
        apiKey: 'anth-secret',
        provider: 'anthropic',
        models: ['conv-model'],
      },
    });
    // Gemini 上游账号。
    await app.inject({
      method: 'POST',
      url: '/llm-gateway/admin/accounts',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'gemini-upstream',
        baseUrl: upstreamUrl,
        apiKey: 'gem-secret',
        provider: 'gemini',
        models: ['gemini-x'],
      },
    });
    // OpenAI Chat 上游账号（baseUrl 不带版本段）。
    await app.inject({
      method: 'POST',
      url: '/llm-gateway/admin/accounts',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'openai-upstream',
        baseUrl: upstreamUrl,
        apiKey: 'oai-secret',
        provider: 'openai-chat',
        models: ['chat-model'],
      },
    });
    // OpenAI Chat 上游账号（baseUrl 已带 /v1，验证版本段去重）。
    await app.inject({
      method: 'POST',
      url: '/llm-gateway/admin/accounts',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'openai-v1-upstream',
        baseUrl: `${upstreamUrl}/v1`,
        apiKey: 'oai-secret',
        provider: 'openai-chat',
        models: ['chat-v1base'],
      },
    });

    const key = await app.inject({
      method: 'POST',
      url: '/llm-gateway/keys',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { name: 'conv', models: 'conv-model,gemini-x,chat-model,chat-v1base' },
    });
    keyPlaintext = (key.json() as { plaintext: string }).plaintext;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_llm-gateway_usage-log"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_llm-gateway_key-policy"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_llm-gateway_legacy-key"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_llm-gateway_user-setting"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_llm-gateway_model-price"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_llm-gateway_account"`);
    await prisma.apiToken.deleteMany({ where: { userId } });
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await prisma.plugin.deleteMany({ where: { id: { in: ['store', 'llm-gateway'] } } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('converts an Anthropic ingress request onto an Anthropic upstream', async () => {
    captured.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/messages',
      headers: { authorization: `Bearer ${keyPlaintext}` },
      payload: {
        model: 'conv-model',
        max_tokens: 128,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { content: Array<{ type: string; text: string }> };
    expect(body.content[0]?.text).toBe('hi from claude');

    const sent = captured.find((c) => c.path.startsWith('/v1/messages'));
    expect(sent?.headers['x-api-key']).toBe('anth-secret');
    expect(sent?.body['max_tokens']).toBe(128);
  });

  it('converts an OpenAI Chat ingress request onto an Anthropic upstream', async () => {
    captured.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${keyPlaintext}` },
      payload: { model: 'conv-model', messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe('hi from claude');

    // 请求被转换成 Anthropic 形态发往上游。
    const sent = captured.find((c) => c.path.startsWith('/v1/messages'));
    expect(sent).toBeTruthy();
    expect(sent?.body['messages']).toBeTruthy();
    expect(sent?.headers['anthropic-version']).toBe('2023-06-01');
    // 计费：11 输入 + 7 输出。
    const prisma = getPrisma();
    const rows = await prisma.$queryRawUnsafe<Array<{ spec: Record<string, unknown> }>>(
      `SELECT "spec" FROM "ext_llm-gateway_usage-log" WHERE "f_userId" = $1 ORDER BY "created_at" DESC LIMIT 1`,
      userId,
    );
    const log = rows[0]?.spec;
    expect(log?.promptTokens).toBe(11);
    expect(log?.completionTokens).toBe(7);
  });

  it('converts an OpenAI Chat ingress request onto a Gemini upstream', async () => {
    captured.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${keyPlaintext}` },
      payload: { model: 'gemini-x', messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe('hi from gemini');

    const sent = captured.find((c) => c.path.startsWith('/v1beta/models/'));
    expect(sent?.path).toContain(':generateContent');
    expect(sent?.headers['x-goog-api-key']).toBe('gem-secret');
    expect(sent?.body['contents']).toBeTruthy();
    expect(sent?.body['model']).toBeUndefined();
  });

  it('converts a Gemini ingress request onto a Gemini upstream', async () => {
    captured.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1beta/models/gemini-x:generateContent',
      headers: { authorization: `Bearer ${keyPlaintext}` },
      payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    expect(body.candidates[0]?.content.parts[0]?.text).toBe('hi from gemini');
  });

  it('converts a streamed Anthropic upstream response into OpenAI Chat SSE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${keyPlaintext}` },
      payload: { model: 'conv-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // 两个 text_delta 分别编码为两条 chunk，拼接后应还原文本。
    expect(res.body).toContain('hi from ');
    expect(res.body).toContain('claude');
    expect(res.body).toContain('[DONE]');
  });

  it('keeps a single Anthropic content block across multiple text deltas when streaming', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/messages',
      headers: { authorization: `Bearer ${keyPlaintext}` },
      payload: {
        model: 'conv-model',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // 两段 text_delta 只能开一个文本块（只数 SSE event 行，避免匹配到 JSON 的 type 字段）。
    const starts = res.body.match(/event: content_block_start/g) ?? [];
    expect(starts).toHaveLength(1);
    expect(res.body).toContain('hi from ');
    expect(res.body).toContain('claude');
    expect(res.body).toContain('message_stop');
  });

  it('converts a streamed Gemini upstream response into Gemini SSE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1beta/models/gemini-x:streamGenerateContent',
      headers: { authorization: `Bearer ${keyPlaintext}` },
      payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('hi from ');
    expect(res.body).toContain('gemini');
    expect(res.body).toContain('usageMetadata');
  });

  it('consolidates converted Gemini deltas into one Anthropic content block', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/messages',
      headers: { authorization: `Bearer ${keyPlaintext}` },
      payload: {
        model: 'gemini-x',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const starts = res.body.match(/event: content_block_start/g) ?? [];
    expect(starts).toHaveLength(1);
    expect(res.body).toContain('hi from ');
    expect(res.body).toContain('gemini');
    expect(res.body).toContain('event: message_stop');
  });

  it('serves a unified model list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/llm-gateway/v1/models',
      headers: { authorization: `Bearer ${keyPlaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    const ids = body.data.map((item) => item.id);
    expect(ids).toContain('conv-model');
    expect(ids).toContain('gemini-x');
  });

  it('converts a cross-protocol request onto an OpenAI Chat upstream at /v1/chat/completions', async () => {
    captured.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/messages',
      headers: { authorization: `Bearer ${keyPlaintext}` },
      payload: {
        model: 'chat-model',
        max_tokens: 32,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { content: Array<{ text: string }> };
    expect(body.content[0]?.text).toBe('hi from chat');

    // 上游账号 baseUrl 不带版本段时，请求必须落到 /v1/chat/completions。
    const sent = captured.find((c) => c.path.startsWith('/v1/chat/completions'));
    expect(sent?.path).toBe('/v1/chat/completions');
    expect(sent?.headers['authorization']).toBe('Bearer oai-secret');
  });

  it('does not duplicate the version segment when the upstream baseUrl already ends in /v1', async () => {
    captured.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/chat/completions',
      headers: { authorization: `Bearer ${keyPlaintext}` },
      payload: { model: 'chat-v1base', messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(res.statusCode).toBe(200);
    const sent = captured.find((c) => c.path.includes('chat/completions'));
    expect(sent?.path).toBe('/v1/chat/completions');
  });

  it('accepts a Responses API request with a plain string input', async () => {
    captured.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1/responses',
      headers: { authorization: `Bearer ${keyPlaintext}` },
      payload: { model: 'chat-model', input: 'hello there', max_output_tokens: 64 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      object: string;
      output: Array<{ content: Array<{ type: string; text: string }> }>;
    };
    expect(body.object).toBe('response');
    expect(body.output[0]?.content[0]?.text).toBe('hi from chat');

    // 字符串 input 必须变成一条 user 消息发往上游，而不是被丢弃成空请求。
    const sent = captured.find((c) => c.path.startsWith('/v1/chat/completions'));
    const messages = sent?.body['messages'] as Array<{ role: string; content: string }>;
    expect(messages?.[0]?.role).toBe('user');
    expect(messages?.[0]?.content).toBe('hello there');
  });

  it('authenticates a Gemini ingress via the x-goog-api-key header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/llm-gateway/v1beta/models/gemini-x:generateContent',
      headers: { 'x-goog-api-key': keyPlaintext },
      payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('authenticates a Gemini ingress via the ?key= query parameter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/llm-gateway/v1beta/models/gemini-x:generateContent?key=${encodeURIComponent(keyPlaintext)}`,
      payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    });
    expect(res.statusCode).toBe(200);
  });
});
