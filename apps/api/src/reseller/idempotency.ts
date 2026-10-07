/**
 * Idempotency for SP v1 writes (P3).
 *
 * Resellers retry; a write must be replay-safe. Mirrors `lib/idempotency.ts`
 * (same `Idempotency-Key` contract, same shared {@link StateService} backend, no
 * new table) but namespaces the memo key by reseller id instead of a platform
 * user — resellers have no `request.user`.
 */
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getStateService } from '../state/index.ts';
import { buildProblem } from '../lib/problem.ts';

const REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 60 * 1000;
const KEY_PREFIX = 'spv1:idem:';

function idempotencyKey(request: FastifyRequest, resellerId: string): string | null {
  const header = request.headers['idempotency-key'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 200) return null;
  const hash = createHash('sha256').update(raw).digest('hex');
  return `${KEY_PREFIX}${resellerId}:${hash}`;
}

/**
 * Run a reseller mutating handler exactly once per `Idempotency-Key`. On a
 * missing key the request is rejected (sp_v1 writes must be replay-safe).
 */
export async function runSpIdempotent(
  request: FastifyRequest,
  reply: FastifyReply,
  resellerId: string,
  handler: () => Promise<unknown>,
): Promise<void> {
  const key = idempotencyKey(request, resellerId);
  if (!key) {
    await reply.code(400).send(
      buildProblem({
        status: 400,
        code: 'request.idempotency_key_required',
        detail: '写操作必须携带 Idempotency-Key 请求头',
        instance: request.url,
        requestId: request.id,
      }),
    );
    return;
  }
  const store = getStateService();
  const cached = await store.get(key);
  if (cached) {
    const replayed = JSON.parse(cached) as { status: number; body: unknown };
    reply.header('idempotency-replayed', 'true');
    await reply.code(replayed.status).send(replayed.body);
    return;
  }
  const lockToken = await store.acquire(`${key}:lock`, LOCK_TTL_MS);
  if (!lockToken) {
    await reply.code(409).send(
      buildProblem({
        status: 409,
        code: 'request.concurrent_request',
        detail: '同一 Idempotency-Key 的请求正在处理中',
        instance: request.url,
        requestId: request.id,
      }),
    );
    return;
  }
  try {
    const body = await handler();
    if (reply.sent || reply.raw.headersSent) return;
    await store.set(key, JSON.stringify({ status: reply.statusCode, body }), REPLAY_TTL_MS);
    await reply.send(body);
  } finally {
    await store.release(`${key}:lock`, lockToken);
  }
}
