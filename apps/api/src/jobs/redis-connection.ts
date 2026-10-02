/**
 * BullMQ connection options derived from `REDIS_URL` (S6).
 *
 * BullMQ must own its connections: its worker uses blocking commands, which
 * require `maxRetriesPerRequest: null` — incompatible with the shared app client
 * (bounded retries). Passing connection options (rather than the shared ioredis
 * instance) lets BullMQ manage its own pool and avoids that conflict.
 */
import type { ConnectionOptions } from 'bullmq';

/** Parse a `redis[s]://` URL into ioredis/BullMQ connection options. */
export function redisConnectionOptions(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const options: ConnectionOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    // Blocking commands (BRPOPLPUSH) must not be aborted by client retries.
    maxRetriesPerRequest: null,
  };
  if (parsed.username) options.username = decodeURIComponent(parsed.username);
  if (parsed.password) options.password = decodeURIComponent(parsed.password);
  const db = parsed.pathname.replace(/^\//, '');
  if (db) options.db = Number(db);
  if (parsed.protocol === 'rediss:') {
    options.tls = {};
  }
  return options;
}
