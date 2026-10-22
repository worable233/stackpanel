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

interface MemoizedResponse {
  status: number;
  body: unknown;
  /** Canonical method/path/query/body fingerprint of the original intent. */
  requestHash: string;
}

/** Serialize JSON-shaped HTTP input deterministically, independent of key order. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** Bind a retry key to the complete request intent, not just the endpoint. */
function requestHash(request: FastifyRequest): string {
  const path = request.url.split('?', 1)[0] ?? request.url;
  return createHash('sha256')
    .update(
      canonicalJson({
        method: request.method,
        path,
        query: request.query,
        body: request.body,
      }),
    )
    .digest('hex');
}

async function sendConflict(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await reply.code(409).send(
    buildProblem({
      status: 409,
      code: 'request.idempotency_conflict',
      detail: '同一 Idempotency-Key 已用于不同的请求参数',
      instance: request.url,
      requestId: request.id,
    }),
  );
}

/** Resolve the caller's idempotency key, namespaced per identity and operation. */
function idempotencyKey(request: FastifyRequest): string | null {
  const header = request.headers['idempotency-key'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 200) return null;
  const scope = request.user?.id ?? 'anon';
  // `routeOptions.url` is `/*` for plugin dispatch, so use the concrete URL
  // pathname. Query parameters are compared in `requestHash`: the same key
  // with different query values is a conflict, not a new operation.
  const path = request.url.split('?', 1)[0] ?? request.url;
  const hash = createHash('sha256').update(`${request.method}:${path}:${raw}`).digest('hex');
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
  const intentHash = requestHash(request);
  const cached = await store.get(key);
  if (cached) {
    let replayed: MemoizedResponse | null = null;
    try {
      replayed = JSON.parse(cached) as MemoizedResponse;
    } catch {
      // A malformed cache entry must never be replayed as a valid success.
    }
    // Entries written before intent binding have no requestHash. Reject them
    // for the remainder of their short TTL instead of guessing that a retry is
    // semantically equivalent.
    if (!replayed || replayed.requestHash !== intentHash) {
      await sendConflict(request, reply);
      return;
    }
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
    // Plugin HttpReply handlers commonly use `reply.code(...).send(...)`. Hold
    // that send until their handler returns, then cache and emit it through the
    // same path as a returned body. This avoids silently skipping memoisation.
    const originalSend = reply.send;
    let directSend = false;
    let directBody: unknown;
    reply.send = ((payload?: unknown) => {
      directSend = true;
      directBody = payload;
      // The SDK contract is `HttpReply.send(): void`. Returning Fastify's
      // thenable reply would make an `async` plugin handler wait forever for a
      // response that this wrapper intentionally has not emitted yet.
      return undefined;
    }) as unknown as typeof reply.send;
    let body: unknown;
    try {
      body = await handler();
    } finally {
      reply.send = originalSend;
    }
    if (reply.sent || reply.raw.headersSent) {
      throw new Error('幂等操作不得绕过 HttpReply.send 直接写入响应');
    }
    if (directSend) body = directBody;
    const result: MemoizedResponse = { status: reply.statusCode, body, requestHash: intentHash };
    await store.set(key, JSON.stringify(result), REPLAY_TTL_MS);
    await reply.send(body);
  } finally {
    await store.release(`${key}:lock`, lockToken);
  }
}
