/**
 * Idempotency for open mutating operations (PLAN-open-platform P1).
 *
 * Third-party callers retry; a write must be safe to replay. A caller supplies
 * `Idempotency-Key`; the first successful response is memoised for a window and
 * replayed verbatim on retry. A short in-flight lock rejects concurrent
 * duplicates with 409 instead of double-applying the effect.
 *
 * Backed by the shared {@link StateService} (Redis in a cluster, in-process
 * otherwise) — no dedicated table, so kernel and plugins share one mechanism.
 */
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getStateService } from '../state/index.ts';
import { buildProblem } from './problem.ts';

/** How long a completed idempotent response is replayable. */
const REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a single in-flight request holds the lock. */
const LOCK_TTL_MS = 60 * 1000;

const KEY_PREFIX = 'idem:';

/** Resolve the caller's idempotency key, namespaced per identity. */
function idempotencyKey(request: FastifyRequest): string | null {
  const header = request.headers['idempotency-key'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 200) return null;
  const scope = request.user?.id ?? 'anon';
  const hash = createHash('sha256').update(raw).digest('hex');
  return `${KEY_PREFIX}${scope}:${hash}`;
}

/**
 * Run a mutating handler exactly once per `Idempotency-Key`.
 *
 * The handler returns the response body; this helper sends it and memoises it.
 * On a missing key the request is rejected (mutating operations must be
 * replay-safe). If the handler throws, nothing is memoised and the caller may
 * retry with the same key.
 */
export async function runIdempotent(
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<unknown>,
): Promise<void> {
  const key = idempotencyKey(request);
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
  const acquired = await store.acquire(`${key}:lock`, LOCK_TTL_MS);
  if (!acquired) {
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
    // A handler may reply directly (e.g. `reply.code(201).send(...)`). In that
    // case there is nothing left to send; still release the lock so a retry is
    // not blocked, but skip memoisation (the response already went out).
    if (reply.sent || reply.raw.headersSent) return;
    const result = { status: reply.statusCode, body };
    await store.set(key, JSON.stringify(result), REPLAY_TTL_MS);
    await reply.send(body);
  } finally {
    await store.release(`${key}:lock`);
  }
}
