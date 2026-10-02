import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { HttpRequest, RawHttpReply, RawHttpRequest } from '@stackpanel/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { checkDbAvailable } from '../helpers.ts';

const dbAvailable = await checkDbAvailable();

async function readBody(req: RawHttpRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req.body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe.skipIf(!dbAvailable)('raw + wildcard plugin routes', () => {
  let app: FastifyInstance;
  let dataDir = '';
  let baseUrl = '';

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-rawdata-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();

    app.pluginDispatcher.register({
      pluginId: 'test-raw',
      kind: 'handler',
      method: 'GET',
      path: '/kw/echo-headers',
      handler: async (req: HttpRequest) => ({
        authorization: req.headers['authorization'] ?? null,
        custom: req.headers['x-custom'] ?? null,
      }),
      isActive: () => true,
    });

    app.pluginDispatcher.register({
      pluginId: 'test-raw',
      kind: 'raw',
      method: 'POST',
      path: '/relay/proxy',
      handler: async (req: RawHttpRequest, reply: RawHttpReply) => {
        const raw = await readBody(req);
        reply
          .status(201)
          .header('x-upstream-id', 'up-1')
          .header('content-type', 'application/json');
        reply.end(JSON.stringify({ method: req.method, body: raw, wildcard: req.params['*'] }));
      },
      isActive: () => true,
    });

    app.pluginDispatcher.register({
      pluginId: 'test-raw',
      kind: 'raw',
      method: 'POST',
      // Invalid JSON must pass through untouched (no 400): raw routes skip parsing.
      path: '/relay/raw',
      handler: async (req: RawHttpRequest, reply: RawHttpReply) => {
        const raw = await readBody(req);
        reply.header('content-type', 'text/plain');
        reply.end(`echo:${raw}`);
      },
      isActive: () => true,
    });

    app.pluginDispatcher.register({
      pluginId: 'test-raw',
      kind: 'raw',
      method: 'PUT',
      path: '/relay/*',
      handler: async (req: RawHttpRequest, reply: RawHttpReply) => {
        reply.header('content-type', 'application/json');
        reply.end(JSON.stringify({ wildcard: req.params['*'] ?? null, method: req.method }));
      },
      isActive: () => true,
    });

    app.pluginDispatcher.register({
      pluginId: 'test-raw',
      kind: 'raw',
      method: 'POST',
      path: '/relay/stream',
      handler: async (_req: RawHttpRequest, reply: RawHttpReply) => {
        reply.status(200).header('content-type', 'text/event-stream');
        reply.write('data: one\n\n');
        await new Promise((resolve) => setTimeout(resolve, 60));
        reply.write('data: two\n\n');
        reply.end();
      },
      isActive: () => true,
    });

    app.pluginDispatcher.register({
      pluginId: 'test-raw',
      kind: 'raw',
      method: 'GET',
      path: '/relay/down',
      handler: async (_req: RawHttpRequest, reply: RawHttpReply) => {
        reply.status(502).header('content-type', 'application/json');
        reply.end(JSON.stringify({ error: 'upstream boom' }));
      },
      isActive: () => false,
    });

    app.pluginDispatcher.register({
      pluginId: 'test-raw',
      kind: 'handler',
      method: 'POST',
      path: '/kw/limited',
      bodyLimit: 8,
      handler: async (req: HttpRequest) => ({ received: req.body }),
      isActive: () => true,
    });

    app.pluginDispatcher.register({
      pluginId: 'test-raw',
      kind: 'handler',
      method: 'GET',
      path: '/kw/cors',
      cors: { origins: ['https://ok.example'], credentials: true, maxAge: 60 },
      handler: async () => ({ ok: true }),
      isActive: () => true,
    });

    // Literal routes must win over the trailing wildcard.
    app.pluginDispatcher.register({
      pluginId: 'test-raw',
      kind: 'handler',
      method: 'PUT',
      path: '/relay/health',
      handler: async () => ({ ok: true }),
      isActive: () => true,
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('exposes request headers to ordinary handler routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/kw/echo-headers',
      headers: { authorization: 'Bearer abc', 'x-custom': 'v1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authorization: 'Bearer abc', custom: 'v1' });
  });

  it('passes the unparsed body, method, and wildcard tail to a raw route', async () => {
    const body = JSON.stringify({ model: 'gpt', stream: true });
    const res = await app.inject({
      method: 'POST',
      url: '/relay/proxy',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-upstream-id']).toBe('up-1');
    expect(res.json()).toMatchObject({ method: 'POST', body });
  });

  it('does not parse or reject an invalid JSON body on a raw route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/relay/raw',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not json',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('echo:{ this is not json');
  });

  it('accepts PUT and captures a nested wildcard tail', async () => {
    const res = await app.inject({ method: 'PUT', url: '/relay/v1/chat/completions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ wildcard: 'v1/chat/completions', method: 'PUT' });
  });

  it('prefers a literal route over the trailing wildcard', async () => {
    const res = await app.inject({ method: 'PUT', url: '/relay/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('passes through a non-2xx upstream status and body', async () => {
    const res = await app.inject({ method: 'GET', url: '/relay/down' });
    // isActive=false → 404 guard, not the handler's 502.
    expect(res.statusCode).toBe(404);
  });

  it('writes per-route CORS headers for an allowed origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/kw/cors',
      headers: { origin: 'https://ok.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://ok.example');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-max-age']).toBe('60');
  });

  it('omits CORS headers for a disallowed origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/kw/cors',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('enforces a per-route body limit on handler routes', async () => {
    const tooBig = await app.inject({
      method: 'POST',
      url: '/kw/limited',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ data: 'much longer than eight bytes' }),
    });
    expect(tooBig.statusCode).toBe(413);

    const ok = await app.inject({
      method: 'POST',
      url: '/kw/limited',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(ok.statusCode).toBe(200);
  });

  it('streams SSE chunks incrementally over a real connection', async () => {
    const response = await fetch(`${baseUrl}/relay/stream`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    if (!reader) throw new Error('no response body');
    const decoder = new TextDecoder();
    const first = await reader.read();
    // First chunk must arrive before the handler's delayed second write.
    expect(decoder.decode(first.value)).toContain('data: one');
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    expect(rest).toContain('data: two');
  });
});
