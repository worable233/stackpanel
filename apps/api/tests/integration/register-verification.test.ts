import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { IdentityChallengeMessage, IdentityChallengeSender } from '@stackpanel/sdk';

// Captcha and send-rate policy still come from the environment; they must be
// set before the env module is imported (see dynamic imports below).
process.env.AUTH_CAPTCHA_MODE = 'off';
process.env.AUTH_CODE_SEND_PER_HOUR = '0';
process.env.AUTH_CODE_SEND_PER_HOUR_PER_IP = '0';

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

/** Test delivery channel capturing the plaintext code for the assertions. */
class MemorySender implements IdentityChallengeSender {
  readonly id = 'memory-test';
  readonly name = 'Memory (test)';
  last: IdentityChallengeMessage | null = null;
  async send(message: IdentityChallengeMessage): Promise<void> {
    this.last = message;
  }
  code(): string {
    if (!this.last) throw new Error('no code captured');
    return this.last.code;
  }
}

describe.skipIf(!dbAvailable)('register email verification (real DB)', () => {
  let app: FastifyInstance;
  const sender = new MemorySender();
  const email = `it_verify_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    // Register the delivery channel the kernel reads live on every issue.
    app.pluginRuntime.registerExtension('identity.challengeSender', sender, 'test-plugin');
    // Registration policy belongs to the login plugin's encrypted settings, not
    // to deployment env (ADR-0016 / login admin settings). Seed the saved config
    // the same way the administrator settings page would.
    await pluginSecrets(getPrisma(), 'login').set(
      'login-config',
      JSON.stringify({ registrationMethods: ['email'], emailVerificationRequired: true }),
    );
  });

  afterAll(async () => {
    await getPrisma().user.deleteMany({ where: { email } });
    await pluginSecrets(getPrisma(), 'login').remove('login-config');
    await app.close();
  });

  it('reports that email verification is required', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/config' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { emailVerificationRequired: boolean }).emailVerificationRequired).toBe(
      true,
    );
  });

  it('rejects registration without a code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('auth.code_missing');
  });

  it('sends a code, rejects a wrong one, then registers with the right one', async () => {
    const send = await app.inject({
      method: 'POST',
      url: '/register/send-code',
      payload: { email },
    });
    expect(send.statusCode).toBe(202);
    expect(sender.last?.code).toMatch(/^\d{6}$/);

    const wrong = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email, password, code: '000000' },
    });
    // Code is 6 digits; a wrong guess (unless accidentally equal) is rejected.
    if (wrong.statusCode === 200) throw new Error('unexpectedly accepted a wrong code');
    expect(['auth.code_invalid', 'auth.code_locked']).toContain(
      (wrong.json() as { code: string }).code,
    );

    const ok = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email, password, code: sender.code() },
    });
    expect(ok.statusCode).toBe(201);
    const body = ok.json() as { user: { email: string; emailVerifiedAt: string | null } };
    expect(body.user.email).toBe(email);
    expect(body.user.emailVerifiedAt).not.toBeNull();

    // The account is ACTIVE and verified in the database.
    const row = await getPrisma().user.findUnique({ where: { email } });
    expect(row?.status).toBe('ACTIVE');
    expect(row?.emailVerifiedAt).not.toBeNull();
  });

  it('does not allow the same code to be consumed twice', async () => {
    const email2 = `it_verify2_${Date.now()}@example.com`;
    const send = await app.inject({
      method: 'POST',
      url: '/register/send-code',
      payload: { email: email2 },
    });
    expect(send.statusCode).toBe(202);
    const code = sender.code();

    const first = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email: email2, password, code },
    });
    expect(first.statusCode).toBe(201);

    // Reuse the same code for a second registration of the same email.
    const replay = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email: email2, password, code },
    });
    expect(replay.statusCode).toBe(400);
    expect((replay.json() as { code: string }).code).toBe('auth.code_missing');

    await getPrisma().user.deleteMany({ where: { email: email2 } });
  });
});
