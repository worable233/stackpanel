import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { peekRedis } from '@stackpanel/db';
import { buildApp } from '../../src/app.ts';
import { REDIS_KEY_PREFIX } from '@stackpanel/sdk';

// This suite proves the cross-replica guarantee: two app instances sharing one
// Redis keep a single rate-limit counter. Requires a live Redis.
const redisUrl = process.env.REDIS_URL;
const redis = peekRedis();

describe.skipIf(!redisUrl || !redis)('Redis-backed rate limiting (shared counter)', () => {
  let appA: FastifyInstance;
  let appB: FastifyInstance;

  beforeAll(async () => {
    const registerProbe = (app: FastifyInstance): void => {
      // Register as a plugin so the rate-limit `onRoute` hook (installed by the
      // rateLimit plugin registered earlier) applies to this route.
      app.register(async (instance) => {
        instance.get(
          '/ratelimit-probe',
          { config: { rateLimit: { max: 2, timeWindow: 60_000 } } },
          async () => ({ ok: true }),
        );
      });
    };
    appA = buildApp({ redis });
    appB = buildApp({ redis });
    registerProbe(appA);
    registerProbe(appB);
    await appA.ready();
    await appB.ready();
    // Clear any counter left by a previous run.
    await clearRateLimitKeys();
  });

  afterAll(async () => {
    await clearRateLimitKeys();
    await appA.close();
    await appB.close();
  });

  it('rejects across instances once the shared limit is reached', async () => {
    const first = await appA.inject({ method: 'GET', url: '/ratelimit-probe' });
    const second = await appA.inject({ method: 'GET', url: '/ratelimit-probe' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    // The third request, on the other instance, must be rejected by the shared
    // counter and carry a Retry-After header.
    const third = await appB.inject({ method: 'GET', url: '/ratelimit-probe' });
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
  });
});

async function clearRateLimitKeys(): Promise<void> {
  if (!redis) return;
  const keys = await redis.keys(`${REDIS_KEY_PREFIX.rateLimit}*`);
  if (keys.length > 0) await redis.del(...keys);
}
