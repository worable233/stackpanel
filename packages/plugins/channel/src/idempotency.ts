/**
 * Idempotency for SP v1 writes (moved out of the kernel under ADR-0021 §D4).
 *
 * Partners retry; a write must be replay-safe. Mirrors the kernel's contract
 * (same `Idempotency-Key` header, same shared state backend; no new table) but
 * namespaces the memo key by partner id, since partners have no platform session.
 */
import { createHash } from 'node:crypto';
import type { RawHttpReply, RawHttpRequest } from '@stackpanel/sdk';
import { stateService } from './context';

const REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 60 * 1000;
const KEY_PREFIX = 'spv1:idem:';

function headerValue(request: RawHttpRequest, name: string): string | null {
  const value = request.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : null;
}

function idempotencyKey(request: RawHttpRequest, partnerId: string): string | null {
  const raw = headerValue(request, 'idempotency-key');
  if (!raw || raw.length < 8 || raw.length > 200) return null;
  const hash = createHash('sha256').update(raw).digest('hex');
  return `${KEY_PREFIX}${partnerId}:${hash}`;
}

function problem(reply: RawHttpReply, status: number, code: string, detail: string): void {
  reply.header('content-type', 'application/problem+json; charset=utf-8');
  reply.status(status);
  reply.end(
    JSON.stringify({
      type: 'about:blank',
      title: status === 409 ? 'Conflict' : 'Bad Request',
      status,
      code,
      detail,
    }),
  );
}

/**
 * Run a partner mutating handler exactly once per `Idempotency-Key`. On a
 * missing key the request is rejected (SP v1 writes must be replay-safe). A
 * replay re-sends the cached body with `idempotency-replayed: true`.
 */
export async function runSpIdempotent(
  request: RawHttpRequest,
  reply: RawHttpReply,
  partnerId: string,
  handler: () => Promise<unknown>,
): Promise<void> {
  const key = idempotencyKey(request, partnerId);
  if (!key) {
    problem(reply, 400, 'request.idempotency_key_required', '写操作必须携带 Idempotency-Key 请求头');
    return;
  }
  const store = stateService();
  const cached = await store.get(key);
  if (cached) {
    const replayed = JSON.parse(cached) as { status: number; body: unknown };
    reply.header('idempotency-replayed', 'true');
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.status(replayed.status);
    reply.end(JSON.stringify(replayed.body));
    return;
  }
  const lockToken = await store.acquire(`${key}:lock`, LOCK_TTL_MS);
  if (!lockToken) {
    problem(reply, 409, 'request.concurrent_request', '同一 Idempotency-Key 的请求正在处理中');
    return;
  }
  try {
    const body = await handler();
    await store.set(key, JSON.stringify({ status: 200, body }), REPLAY_TTL_MS);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.status(200);
    reply.end(JSON.stringify(body));
  } finally {
    await store.release(`${key}:lock`, lockToken);
  }
}
