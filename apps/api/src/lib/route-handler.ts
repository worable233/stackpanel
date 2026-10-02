/**
 * Kernel↔plugin HTTP handler marshalling.
 *
 * The open `/api/v1` aliases and plugin routes registered directly on Fastify
 * both need to invoke a plugin's framework-agnostic {@link RouteHandler} with a
 * Fastify request/reply pair. This adapter lives in one place so the two
 * callers cannot drift: same view construction, same "send the return value
 * unless the handler already replied" convention.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HttpRequest, HttpReply, RouteHandler } from '@stackpanel/sdk';

/** Project a Fastify request into the framework-agnostic view plugins receive. */
export function toHttpRequest(
  request: FastifyRequest,
  params: Record<string, string> = {},
): HttpRequest {
  return {
    params,
    query: request.query as Record<string, unknown>,
    body: request.body,
    headers: request.headers,
    ip: request.ip,
    ...(request.user
      ? {
          user: {
            id: request.user.id,
            email: request.user.email,
            role: request.user.permissions.has('platform.admin') ? 'ADMIN' : 'USER',
          },
        }
      : {}),
    ...(request.sessionToken ? { sessionToken: request.sessionToken } : {}),
  };
}

/** Run a plugin handler against a Fastify request/reply pair. */
export async function invokeRouteHandler(
  handler: RouteHandler,
  request: FastifyRequest,
  reply: FastifyReply,
  params: Record<string, string> = {},
): Promise<void> {
  const result = await handler(toHttpRequest(request, params), reply as unknown as HttpReply);
  if (!reply.sent && !reply.raw.headersSent) {
    await reply.send(result);
  }
}
