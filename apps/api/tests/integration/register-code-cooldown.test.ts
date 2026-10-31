import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { IdentityChallengeMessage, IdentityChallengeSender } from '@stackpanel/sdk';

// The per-recipient cooldown is the point of this file, so it is deliberately on
// while the hourly caps stay off: the hourly cap alone lets a caller burn the
// whole quota inside one second.
process.env.AUTH_CAPTCHA_MODE = 'off';
process.env.AUTH_CODE_SEND_PER_HOUR = '0';
process.env.AUTH_CODE_SEND_PER_HOUR_PER_IP = '0';
process.env.AUTH_CODE_SEND_COOLDOWN_SECONDS = '60';

const { buildApp } = await import('../../src/app.ts');
const { getPrisma } = await import('../../src/plugins/prisma.ts');
const { pluginSecrets } = await import('../../src/lib/crypto.ts');

const dbAvailable = await (async () => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

class MemorySender implements IdentityChallengeSender {
  readonly id = 'memory-cooldown';
  readonly name = 'Memory (cooldown test)';
  sent = 0;
  async send(_message: IdentityChallengeMessage): Promise<void> {
    this.sent += 1;
  }
}

describe.skipIf(!dbAvailable)('register code cooldown (real DB)', () => {
  let app: FastifyInstance;
  const sender = new MemorySender();
  const email = `it_cooldown_${Date.now()}@example.com`;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    app.pluginRuntime.registerExtension('identity.challengeSender', sender, 'test-plugin');
    await pluginSecrets(getPrisma(), 'login').set(
      'login-config',
      JSON.stringify({ registrationMethods: ['email'], emailVerificationRequired: true }),
    );
  });

  afterAll(async () => {
    await getPrisma().identityChallenge.deleteMany({ where: { email } });
    await pluginSecrets(getPrisma(), 'login').remove('login-config');
    await app.close();
  });

  it('delivers the first code, then refuses a second one immediately', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/register/send-code',
      payload: { email },
    });
    expect(first.statusCode).toBe(202);
    expect(sender.sent).toBe(1);

    // Same address, one second later: an inbox bomb is exactly this loop.
    const second = await app.inject({
      method: 'POST',
      url: '/register/send-code',
      payload: { email },
    });
    expect(second.statusCode).toBe(429);
    expect((second.json() as { code: string }).code).toBe('auth.code_rate_limited');
    // Nothing was delivered for the refused request.
    expect(sender.sent).toBe(1);
  });

  it('keeps the cooldown per recipient, not globally', async () => {
    const other = `it_cooldown_other_${Date.now()}@example.com`;
    const res = await app.inject({
      method: 'POST',
      url: '/register/send-code',
      payload: { email: other },
    });
    expect(res.statusCode).toBe(202);
    expect(sender.sent).toBe(2);
    await getPrisma().identityChallenge.deleteMany({ where: { email: other } });
  });
});
