/**
 * MCP (Model Context Protocol) endpoint — Streamable HTTP, PLAN-open-platform P2.
 *
 * A deliberately thin transport adapter. It does not know any domain operation:
 * it authenticates with the same credential as `/api/v1` (a platform `ApiToken`
 * or a session cookie — "sticky token"), derives its tool list from the same
 * capability registry, and executes every tool by re-entering the app's own
 * HTTP stack at the tool's `/api/v1` URL. That in-turn path runs the real
 * `requireAuth` / `requirePermission` / quota / idempotency guards, so an agent
 * can do exactly what its credential can do and nothing more (ADR-0001).
 *
 * Framing: the request body is one JSON-RPC message (or a batch); the response
 * is `application/json`. Notifications (no `id`) get `202 Accepted` with no
 * body, matching the Streamable HTTP transport.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { extractSession } from '../plugins/auth.ts';
import { buildProblem } from '../lib/problem.ts';
import { handleMcpRequest, type McpExecutionResult } from './server.ts';
import type { McpApiCall } from '@stackpanel/sdk';

/** Execute a resolved tool call through the app's own inject() stack. */
async function executeViaApi(
  request: FastifyRequest,
  call: McpApiCall,
): Promise<McpExecutionResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const authorization = request.headers.authorization;
  const cookie = request.headers.cookie;
  if (typeof authorization === 'string') headers['authorization'] = authorization;
  if (typeof cookie === 'string') headers['cookie'] = cookie;
  if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;

  const response = await request.server.inject({
    method: call.method,
    url: call.path,
    headers,
    ...(call.body !== undefined ? { payload: call.body as Record<string, unknown> } : {}),
  });
  return {
    statusCode: response.statusCode,
    contentType: String(response.headers['content-type'] ?? ''),
    body: response.body,
  };
}

/** 202 with no body for a notification-only payload (per the MCP transport). */
async function accepted(reply: FastifyReply): Promise<void> {
  await reply.code(202).send();
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Streamable HTTP transport. POST carries JSON-RPC messages; GET is the SSE
   * stream, which this server-side surface does not provide (405), and DELETE
   * (session termination) is stateless here (204).
   */
  app.post('/mcp', { preHandler: requireMcpAuth }, async (request, reply) => {
    const result = await handleMcpRequest(request, (call) => executeViaApi(request, call));
    if (result === null) {
      await accepted(reply);
      return;
    }
    return result;
  });

  app.get('/mcp', { preHandler: requireMcpAuth }, async (_request, reply) => {
    await reply.code(405).send(
      buildProblem({
        status: 405,
        code: 'mcp.sse_unsupported',
        detail: 'MCP 服务端不支持 SSE 长连接，请使用 POST 发送 JSON-RPC 消息',
        instance: '/mcp',
      }),
    );
  });

  app.delete('/mcp', { preHandler: requireMcpAuth }, async (_request, reply) => {
    await reply.code(204).send();
  });
}

/** Authenticate the MCP credential once, up-front (the dispatcher/tool guards re-check). */
async function requireMcpAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await extractSession(request, reply);
  if (!user) {
    await reply.code(401).send(
      buildProblem({
        status: 401,
        code: 'auth.unauthenticated',
        detail: 'MCP 请求需要有效的平台凭证（Authorization: Bearer <token>）',
        instance: request.url,
        requestId: request.id,
      }),
    );
    return;
  }
  request.user = user;
}
