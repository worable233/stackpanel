/**
 * Redis key namespaces.
 *
 * A single Redis instance is partitioned by key prefix (ADR-0017 §8): sessions,
 * cache, rate limiting, plugin state, pub/sub and runtime invalidation each own
 * a namespace so they never collide and can be inspected/evicted independently.
 *
 * `bull:` is owned by BullMQ and must keep that exact literal prefix.
 */
export const REDIS_KEY_PREFIX = {
  session: 'sp:session:',
  cache: 'sp:cache:',
  rateLimit: 'sp:ratelimit:',
  state: 'sp:state:',
  pubsub: 'sp:pubsub:',
  runtime: 'sp:runtime:',
  bull: 'bull:',
  /** Kernel job bookkeeping (dead-letter records, schedule registry). */
  jobs: 'sp:jobs:',
} as const;

export type RedisKeyNamespace = keyof typeof REDIS_KEY_PREFIX;

/** Build a namespaced Redis key: `redisKey('state', 'plugin', id)`. */
export function redisKey(namespace: RedisKeyNamespace, ...parts: string[]): string {
  return REDIS_KEY_PREFIX[namespace] + parts.join(':');
}
