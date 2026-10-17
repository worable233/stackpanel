/**
 * 商城写操作的幂等保护（PLAN-storefront-display-account-commerce §3 阶段 3）。
 *
 * 下单 / 购物车结账 / 续费 / 变配等写操作一旦被重复提交（双击、网络重试、
 * 回退重放），会重复建单、重复扣库存或重复扣款。内核只在 `/api/v1` 开放别名上
 * 强制 `Idempotency-Key`，站内账户接口此前没有任何重放保护；这里复用内核同一套
 * `StateService`（集群下 Redis、单机进程内）补齐：
 *
 * - 调用方带 `Idempotency-Key` 时，首次成功响应在窗口内按 (scope, user, key)
 *   记忆，重放逐字返回；请求体与首次不一致则 409，绝不静默套用。
 * - 并发同键以短锁拒绝（409），避免同时执行两次。
 * - 未带键时保持旧语义（直接执行），不破坏既有前端与测试。
 *
 * 该状态键与内核 `idem:` 前缀隔离，且键内含用户，跨用户不可碰撞。
 */
import { createHash } from 'node:crypto';
import type { HttpRequest } from '@stackpanel/sdk';
import { context } from './context';
import { StoreError } from './errors';

/** 已完成响应可重放的窗口。 */
const REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
/** 单次在途请求持有锁的时长。 */
const LOCK_TTL_MS = 60 * 1000;

interface Memoized<T> {
  /** 首次请求体的指纹，用于检测「同键不同参」。 */
  bodyHash: string;
  result: T;
}

/** 取得合法的 `Idempotency-Key`，缺失或非法返回 null（不强制）。 */
function idempotencyKey(req: HttpRequest): string | null {
  const header = req.headers['idempotency-key'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 200) return null;
  return raw;
}

function bodyHashOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

/**
 * 在幂等保护下执行一次写操作。
 *
 * `scope` 区分操作类别（如 `order.create` / `cart.checkout`），使同一个 key 在
 * 不同写路径之间互不干扰。handler 抛错时不清除键，允许调用方用同一键重试。
 */
export async function withIdempotency<T>(
  req: HttpRequest,
  scope: string,
  handler: () => Promise<T>,
): Promise<T> {
  const raw = idempotencyKey(req);
  if (!raw) return handler();
  const userId = req.user?.id ?? 'anon';
  const hash = createHash('sha256').update(raw).digest('hex');
  const key = `store:idem:${scope}:${userId}:${hash}`;
  const state = context().state;
  const bodyHash = bodyHashOf(req.body);

  const cached = await state.get(key);
  if (cached !== null) {
    const memo = JSON.parse(cached) as Memoized<T>;
    if (memo.bodyHash !== bodyHash) {
      throw new StoreError(409, '幂等键已用于不同的请求，请重新提交');
    }
    return memo.result;
  }

  const lockToken = await state.acquire(`${key}:lock`, LOCK_TTL_MS);
  if (!lockToken) throw new StoreError(409, '相同请求正在处理中，请稍候');
  try {
    const result = await handler();
    await state.set(key, JSON.stringify({ bodyHash, result } satisfies Memoized<T>), REPLAY_TTL_MS);
    return result;
  } finally {
    await state.release(`${key}:lock`, lockToken);
  }
}
