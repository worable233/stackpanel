import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';

/**
 * The 429 that ends a credential-stuffing burst must say **how long** to wait.
 *
 * Without it every client guesses: the web form can only print "too often",
 * which reads as "this is broken" and invites the user to keep clicking — each
 * click extending the window. Asserted end-to-end because the number is derived
 * from plugin state TTLs and rendered by the kernel error boundary, and either
 * half can regress silently.
 */
const dbAvailable = await (async (): Promise<boolean> => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbAvailable)('login rate limit (real DB)', () => {
  let app: FastifyInstance;
  const email = `rl_${Date.now()}@example.com`;
  const previous = process.env.LOGIN_RATE_LIMIT_MAX;

  beforeAll(async () => {
    // Three attempts are enough to observe the ceiling; the plugin reads this at
    // call time, so it must be set before the requests, not before buildApp().
    process.env.LOGIN_RATE_LIMIT_MAX = '3';
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    // No account is created on purpose: the per-IP bucket trips first, so the
    // test never needs a real credential (and cannot leak a login attempt into
    // the per-user bucket of another test).
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.LOGIN_RATE_LIMIT_MAX;
    else process.env.LOGIN_RATE_LIMIT_MAX = previous;
    await getPrisma().user.deleteMany({ where: { email } });
    await app.close();
  });

  it('answers 429 with the remaining wait in both the header and the body', async () => {
    let throttled: Awaited<ReturnType<typeof app.inject>> | undefined;
    const seen: number[] = [];
    for (let attempt = 0; attempt < 6 && !throttled; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        payload: { email, password: 'wrong-password' },
      });
      seen.push(res.statusCode);
      if (res.statusCode === 429) throttled = res;
    }
    // 401 while under the ceiling, then 429 — never a 429 first.
    expect(seen.slice(0, -1).every((status) => status === 401)).toBe(true);
    expect(throttled).toBeDefined();
    if (!throttled) return;
    expect(throttled.statusCode).toBe(429);
    const body = throttled.json() as { code?: string; retryAfterSeconds?: number };
    expect(body.code).toBe('auth.rate_limited');
    expect(typeof body.retryAfterSeconds).toBe('number');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    // Transport-level mirror: a proxy may strip the body's field but not the
    // header, and a non-browser client reads only the header.
    expect(throttled.headers['retry-after']).toBe(String(body.retryAfterSeconds));
  });
});
