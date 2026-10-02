/**
 * Open platform (/api/v1) per-token guard and usage audit (PLAN-open-platform P1).
 *
 * The open surface is credential-first: a self-service `ApiToken` represents a
 * person. Two protections travel with it, both per token:
 *
 *   - **RPM + concurrency limits**, held in the shared {@link StateService}
 *     (Redis in a cluster) so the ceiling holds across replicas.
 *   - **Usage audit** into `api_token_usage`, one row per call, so an operator
 *     can see what a key did. Only token-authenticated calls are recorded; the
 *     session-cookie path is the internal BFF surface, not the open one.
 *
 * Both are best-effort on the audit side and fail-closed on the limit side.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.ts';
import { getStateService } from '../state/index.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { buildProblem } from './problem.ts';
import { matchCapability, type Capability } from './capability-registry.ts';

const RPM_TTL_MS = 60_000;
/** Safety TTL for the concurrency counter so a crashed request cannot wedge a token. */
const INFLIGHT_TTL_MS = 5 * 60_000;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set while an open-API token request is counted against its concurrency cap. */
    openApiTokenId?: string;
    openApiCounted?: boolean;
  }
}

/** Whether this request is an open-API call authenticated by a platform token. */
function tokenId(request: FastifyRequest): string | undefined {
  const user = request.user;
  return user?.viaApiToken && user.tokenId ? user.tokenId : undefined;
}

/**
 * RPM + concurrency preHandler for the `/api/v1` scope. No-ops unless the caller
 * presented an API token, so public and session requests are unaffected.
 */
export async function enforceTokenQuota(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const id = tokenId(request);
  if (!id) return;
  const state = getStateService();

  if (env.OPEN_API_TOKEN_RPM > 0) {
    const hits = await state.incr(`open:rpm:${id}`, RPM_TTL_MS);
    if (hits > env.OPEN_API_TOKEN_RPM) {
      reply.header('retry-after', '60');
      await reply.code(429).send(
        buildProblem({
          status: 429,
          code: 'request.rate_limited',
          detail: '请求过于频繁，请稍后再试',
          instance: request.url,
          requestId: request.id,
        }),
      );
      return;
    }
  }

  if (env.OPEN_API_TOKEN_CONCURRENCY > 0) {
    const inflight = await state.incr(`open:inflight:${id}`, INFLIGHT_TTL_MS);
    if (inflight > env.OPEN_API_TOKEN_CONCURRENCY) {
      await state.decr(`open:inflight:${id}`);
      reply.header('retry-after', '1');
      await reply.code(429).send(
        buildProblem({
          status: 429,
          code: 'request.concurrent_request',
          detail: '并发请求超出限制，请稍后再试',
          instance: request.url,
          requestId: request.id,
        }),
      );
      return;
    }
    request.openApiTokenId = id;
    request.openApiCounted = true;
  }
}

/** Release the concurrency slot acquired by {@link enforceTokenQuota}. */
export async function releaseTokenQuota(request: FastifyRequest): Promise<void> {
  if (!request.openApiCounted || !request.openApiTokenId) return;
  await getStateService().decr(`open:inflight:${request.openApiTokenId}`).catch(() => 0);
}

/**
 * Record one token call. Best-effort: a logging failure must never turn a
 * successful response into an error, so the caller invokes this without awaiting
 * a rejection. No-ops for non-token callers and non-`/api/v1` paths.
 */
export function recordTokenUsage(
  request: FastifyRequest,
  reply: FastifyReply,
  pluginCapabilities: readonly Capability[] = [],
): void {
  const id = tokenId(request);
  if (!id) return;
  const user = request.user;
  if (!user) return;
  const pathname = request.url.split('?')[0] ?? request.url;
  if (!pathname.startsWith('/api/v1')) return;
  const capability = matchCapability(request.method, pathname, pluginCapabilities);

  void getPrisma()
    .apiTokenUsage.create({
      data: {
        apiTokenId: id,
        userId: user.id,
        method: request.method,
        path: pathname,
        ...(capability ? { capabilityId: capability.id } : {}),
        statusCode: reply.statusCode,
        durationMs: Math.max(0, Math.round(reply.elapsedTime)),
        ...(request.ip ? { ip: request.ip } : {}),
        ...(typeof request.headers['user-agent'] === 'string'
          ? { userAgent: request.headers['user-agent'] }
          : {}),
      },
    })
    .catch(() => undefined);
}
