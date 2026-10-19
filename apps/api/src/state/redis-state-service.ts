/**
 * Redis-backed {@link StateService} (ADR-0017 / S5.5).
 *
 * The kernel state is shared coordination (counters, TTL keys, locks). In a
 * multi-replica deployment every replica must observe the same values, so the
 * in-process {@link MemoryStateService} is a development-only fallback and this
 * implementation is the real one. Semantics mirror the in-process contract
 * exactly — including the rule that `incr` sets the TTL only on the first
 * increment and `decr` floors at zero — so consumers (llm-gateway) need no
 * changes.
 *
 * Keys are namespaced with `sp:state:` so state can be inspected/evicted
 * independently of sessions, rate limits and the queue (ADR-0017 §8).
 */
import { randomUUID } from 'node:crypto';
import type { RedisClient } from '@stackpanel/db';
import { REDIS_KEY_PREFIX } from '@stackpanel/sdk';
import type { StateCandidate, StateLease, StateService } from '@stackpanel/sdk';

/** Redis `PX` only accepts whole-millisecond TTLs; non-positive means "no TTL". */
function toTtlMs(ttlMs: number | undefined): number | undefined {
  if (ttlMs === undefined || ttlMs <= 0) return undefined;
  return Math.floor(ttlMs);
}

/**
 * Atomic decrement floored at zero, preserved TTL. Redis `DECR` alone can go
 * negative; the in-process contract never does. `KEEPTTL` keeps the original
 * expiry (Redis >= 6).
 */
const DECR_FLOOR_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local next = current - 1
if next < 0 then next = 0 end
redis.call('SET', KEYS[1], next, 'KEEPTTL')
return next
`;

/** Release a lock only if the stored token is still ours (compare-and-delete). */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const CONSUME_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value
`;

/** Increment a counter and attach its window TTL in one Redis transaction. */
const INCR_WITH_TTL_SCRIPT = `
local value = redis.call('INCR', KEYS[1])
if value == 1 and tonumber(ARGV[1]) ~= nil and tonumber(ARGV[1]) > 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return value
`;

/**
 * Take the first free seat among ordered lease pools, in one round trip.
 *
 * `KEYS[i]` is pool `i`'s ZSET; `ARGV[4+i]` its limit (0 = unlimited).
 * `ARGV[1]` is now (ms), `ARGV[2]` the caller's unique token, `ARGV[3]` the TTL
 * in ms (0 = none). A pool at/over its limit is skipped **without** being
 * modified. Returns the index (1-based) of the seat taken, or 0 when full.
 */
const LEASE_ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local token = ARGV[2]
local ttl = tonumber(ARGV[3]) or 0
-- A 0 TTL means "no expiry"; store it far in the future so the expired-entry
-- prune below never reclaims a live seat.
local expires = now + 315360000000
if ttl > 0 then expires = now + ttl end
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  local limit = tonumber(ARGV[3 + i]) or 0
  local size = redis.call('ZCARD', KEYS[i])
  if limit <= 0 or size < limit then
    redis.call('ZADD', KEYS[i], expires, token)
    if ttl > 0 then redis.call('PEXPIRE', KEYS[i], ttl) end
    return i
  end
end
return 0
`;

/** Extend this holder's seat; 1 when it still held one, 0 when it had expired. */
const LEASE_RENEW_SCRIPT = `
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2]) or 0
local expires = now + 315360000000
if ttl > 0 then expires = now + ttl end
if not redis.call('ZSCORE', KEYS[1], ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], expires, ARGV[3])
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1
`;

/** Release only this holder's seat; returns 1 (released), 0 (nothing to do). */
const LEASE_RELEASE_SCRIPT = `
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
local now = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return removed
`;

export class RedisStateService implements StateService {
  constructor(private readonly redis: RedisClient) {}

  private key(key: string): string {
    return `${REDIS_KEY_PREFIX.state}${key}`;
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(this.key(key));
  }

  async consume(key: string): Promise<string | null> {
    const value = await this.redis.eval(CONSUME_SCRIPT, 1, this.key(key));
    return typeof value === 'string' ? value : null;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const ttl = toTtlMs(ttlMs);
    if (ttl === undefined) {
      await this.redis.set(this.key(key), value);
    } else {
      await this.redis.set(this.key(key), value, 'PX', ttl);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(this.key(key));
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    const redisKey = this.key(key);
    const ttl = toTtlMs(ttlMs);
    // INCR and the first-window expiry must be one operation. Otherwise a key
    // can expire between SET NX and INCR and be recreated without a TTL.
    return (await this.redis.eval(
      INCR_WITH_TTL_SCRIPT,
      1,
      redisKey,
      String(ttl ?? 0),
    )) as number;
  }

  async decr(key: string): Promise<number> {
    const result = (await this.redis.eval(DECR_FLOOR_SCRIPT, 1, this.key(key))) as number;
    return result;
  }

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(
      this.key(key),
      token,
      'PX',
      toTtlMs(ttlMs) ?? 1,
      'NX',
    );
    return result === 'OK' ? token : null;
  }

  async release(key: string, token: string): Promise<boolean> {
    return Number(await this.redis.eval(RELEASE_SCRIPT, 1, this.key(key), token)) === 1;
  }

  async withLock(key: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean> {
    const redisKey = this.key(key);
    const token = randomUUID();
    // Acquire directly (not via `acquire`) so we control the token and can
    // release with compare-and-delete: a lock that expired and was re-acquired
    // elsewhere is never released by our stale cleanup.
    const acquired = await this.redis.set(redisKey, token, 'PX', toTtlMs(ttlMs) ?? 1, 'NX');
    if (acquired !== 'OK') return false;
    try {
      await fn();
      return true;
    } finally {
      await this.redis.eval(RELEASE_SCRIPT, 1, redisKey, token).catch(() => undefined);
    }
  }

  async acquireLease(
    candidates: ReadonlyArray<StateCandidate>,
    ttlMs?: number,
  ): Promise<StateLease | null> {
    if (candidates.length === 0) return null;
    const token = randomUUID();
    const keys = candidates.map((candidate) => this.key(candidate.key));
    const limits = candidates.map((candidate) => String(Math.max(0, Math.trunc(candidate.limit))));
    const ttl = toTtlMs(ttlMs) ?? 0;
    const seat = Number(
      await this.redis.eval(
        LEASE_ACQUIRE_SCRIPT,
        keys.length,
        ...keys,
        String(Date.now()),
        token,
        String(ttl),
        ...limits,
      ),
    );
    const candidate = candidates[seat - 1];
    return candidate ? { key: candidate.key, token } : null;
  }

  async renewLease(lease: StateLease, ttlMs?: number): Promise<boolean> {
    const ttl = toTtlMs(ttlMs) ?? 0;
    const renewed = Number(
      await this.redis.eval(
        LEASE_RENEW_SCRIPT,
        1,
        this.key(lease.key),
        String(Date.now()),
        String(ttl),
        lease.token,
      ),
    );
    return renewed === 1;
  }

  async releaseLease(lease: StateLease): Promise<boolean> {
    const removed = Number(
      await this.redis.eval(
        LEASE_RELEASE_SCRIPT,
        1,
        this.key(lease.key),
        lease.token,
        String(Date.now()),
      ),
    );
    return removed > 0;
  }
}
