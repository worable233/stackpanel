/**
 * Server-side session store (ADR-0017 §4).
 *
 * Sessions are opaque random tokens whose state lives in Redis, so every
 * replica sees the same session and a `revoke` takes effect immediately
 * cluster-wide. When `REDIS_URL` is absent (development / hermetic tests) an
 * in-process fallback is used; production requires Redis (enforced by
 * `readInfraConfig`, so this module never silently degrades there).
 *
 * Key layout (all under the `sp:session:` namespace, ADR-0017 §8):
 *   - `sp:session:<token>`         JSON record, TTL = SESSION_TTL_SECONDS.
 *   - `sp:session:user:<userId>`   SET of the user's session tokens (revokeAll).
 *
 * TTL slides on access, throttled by {@link TOUCH_INTERVAL_MS} so an active
 * session renews without a write on every single request.
 */
import { randomBytes } from 'node:crypto';
import { peekRedis } from '@stackpanel/db';
import { redisKey } from '@stackpanel/sdk';
import { env } from '../config/env.ts';

export interface SessionRecord {
  userId: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface SessionStore {
  /** Create a new random session for `userId`; returns the opaque token. */
  create(userId: string): Promise<string>;
  /** Persist a session under an explicit token (legacy JWT migration path). */
  adopt(token: string, userId: string): Promise<void>;
  /** Read a session and slide its TTL; returns null when absent/expired. */
  get(token: string): Promise<SessionRecord | null>;
  /** Revoke a single session immediately. */
  revoke(token: string): Promise<void>;
  /** Revoke every session owned by `userId` (password change / ban / logout-all). */
  revokeAll(userId: string): Promise<void>;
}

/** Session lifetime in seconds (matches the cookie `maxAge`). */
function ttlSeconds(): number {
  return env.SESSION_TTL_SECONDS;
}

/** Only refresh a session's TTL once per minute, not on every request. */
const TOUCH_INTERVAL_MS = 60_000;

/** Opaque token distinct from the `sp_` API-token prefix. */
export function newSessionToken(): string {
  return `sess_${randomBytes(32).toString('base64url')}`;
}

function sessionKey(token: string): string {
  return redisKey('session', token);
}

function userIndexKey(userId: string): string {
  return redisKey('session', 'user', userId);
}

type RedisClient = NonNullable<ReturnType<typeof peekRedis>>;

class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: RedisClient) {}

  private async persist(token: string, record: SessionRecord): Promise<void> {
    const ttl = ttlSeconds();
    await this.redis
      .multi()
      .set(sessionKey(token), JSON.stringify(record), 'EX', ttl)
      .sadd(userIndexKey(record.userId), token)
      .expire(userIndexKey(record.userId), ttl)
      .exec();
  }

  async create(userId: string): Promise<string> {
    const token = newSessionToken();
    const now = Date.now();
    await this.persist(token, { userId, createdAt: now, lastSeenAt: now });
    return token;
  }

  async adopt(token: string, userId: string): Promise<void> {
    const now = Date.now();
    const existing = await this.get(token);
    await this.persist(token, {
      userId,
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
    });
  }

  async get(token: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(sessionKey(token));
    if (!raw) return null;
    let record: SessionRecord;
    try {
      record = JSON.parse(raw) as SessionRecord;
    } catch {
      await this.redis.del(sessionKey(token)).catch(() => undefined);
      return null;
    }
    const now = Date.now();
    if (now - record.lastSeenAt > TOUCH_INTERVAL_MS) {
      record.lastSeenAt = now;
      await this.redis
        .multi()
        .set(sessionKey(token), JSON.stringify(record), 'EX', ttlSeconds())
        .expire(userIndexKey(record.userId), ttlSeconds())
        .exec()
        .catch(() => undefined);
    }
    return record;
  }

  async revoke(token: string): Promise<void> {
    const record = await this.get(token);
    const pipeline = this.redis.multi().del(sessionKey(token));
    if (record) pipeline.srem(userIndexKey(record.userId), token);
    await pipeline.exec();
  }

  async revokeAll(userId: string): Promise<void> {
    const indexKey = userIndexKey(userId);
    const tokens = await this.redis.smembers(indexKey);
    const pipeline = this.redis.multi();
    for (const token of tokens) pipeline.del(sessionKey(token));
    pipeline.del(indexKey);
    await pipeline.exec();
  }
}

interface MemoryRecord extends SessionRecord {
  expiresAt: number;
}

class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, MemoryRecord>();
  private readonly userIndex = new Map<string, Set<string>>();

  async create(userId: string): Promise<string> {
    const token = newSessionToken();
    const now = Date.now();
    this.write(token, { userId, createdAt: now, lastSeenAt: now });
    return token;
  }

  async adopt(token: string, userId: string): Promise<void> {
    const now = Date.now();
    const existing = await this.get(token);
    this.write(token, {
      userId,
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
    });
  }

  async get(token: string): Promise<SessionRecord | null> {
    const record = this.sessions.get(token);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      await this.revoke(token);
      return null;
    }
    const now = Date.now();
    if (now - record.lastSeenAt > TOUCH_INTERVAL_MS) {
      record.lastSeenAt = now;
      record.expiresAt = now + ttlSeconds() * 1000;
    }
    return {
      userId: record.userId,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
    };
  }

  async revoke(token: string): Promise<void> {
    const record = this.sessions.get(token);
    this.sessions.delete(token);
    if (record) this.userIndex.get(record.userId)?.delete(token);
  }

  async revokeAll(userId: string): Promise<void> {
    const tokens = this.userIndex.get(userId);
    if (tokens) {
      for (const token of tokens) this.sessions.delete(token);
      this.userIndex.delete(userId);
    }
  }

  private write(token: string, record: SessionRecord): void {
    this.sessions.set(token, { ...record, expiresAt: Date.now() + ttlSeconds() * 1000 });
    let index = this.userIndex.get(record.userId);
    if (!index) {
      index = new Set();
      this.userIndex.set(record.userId, index);
    }
    index.add(token);
  }
}

const memoryStore = new MemorySessionStore();

/**
 * Resolve the active session store. Redis when connected (multi-replica),
 * otherwise the in-process fallback for development and hermetic tests.
 */
export function getSessionStore(): SessionStore {
  const redis = peekRedis();
  return redis ? new RedisSessionStore(redis) : memoryStore;
}
