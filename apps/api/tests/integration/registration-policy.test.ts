import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { IdentityChallengeMessage, IdentityChallengeSender } from '@stackpanel/sdk';

// Captcha policy and send quotas come from the environment; they must be set
// before the env module is imported (see the dynamic imports below). Attempt
// ceilings are disabled here because each test case deliberately repeats calls
// that the production defaults would throttle.
process.env.AUTH_CAPTCHA_MODE = 'off';
process.env.AUTH_CODE_SEND_PER_HOUR = '0';
process.env.AUTH_CODE_SEND_PER_HOUR_PER_IP = '0';
process.env.LOGIN_RATE_LIMIT_MAX = '0';
process.env.REGISTER_RATE_LIMIT_MAX = '0';

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
  readonly id = 'memory-policy-test';
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

type Json = Record<string, unknown>;

describe.skipIf(!dbAvailable)('registration policy and password reset (real DB)', () => {
  let app: FastifyInstance;
  const sender = new MemorySender();
  const secrets = () => pluginSecrets(getPrisma(), 'login');
  const stamp = Date.now();
  const created = new Set<string>();

  function emailFor(label: string): string {
    const email = `it_policy_${label}_${stamp}@example.com`;
    created.add(email);
    return email;
  }

  async function setConfig(config: {
    registrationMethods: string[];
    emailVerificationRequired?: boolean;
  }): Promise<void> {
    await secrets().set(
      'login-config',
      JSON.stringify({
        registrationMethods: config.registrationMethods,
        emailVerificationRequired: config.emailVerificationRequired ?? false,
      }),
    );
  }

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
  });

  afterAll(async () => {
    if (created.size > 0) {
      await getPrisma().user.deleteMany({ where: { email: { in: [...created] } } });
    }
    await secrets().remove('login-config');
    await app.close();
  });

  it('refuses registration when the operator closed sign-ups', async () => {
    await setConfig({ registrationMethods: [] });
    const email = emailFor('closed');

    const config = await app.inject({ method: 'GET', url: '/auth/config' });
    expect(config.statusCode).toBe(200);
    expect((config.json() as Json)['registrationEnabled']).toBe(false);

    const register = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email, password: 'IntegrationPass123' },
    });
    expect(register.statusCode).toBe(403);
    expect((register.json() as Json)['code']).toBe('auth.registration_closed');

    const sendCode = await app.inject({
      method: 'POST',
      url: '/register/send-code',
      payload: { email },
    });
    expect(sendCode.statusCode).toBe(403);
    expect((sendCode.json() as Json)['code']).toBe('auth.registration_closed');
  });

  it('fails closed when verification is required but nothing can deliver it', async () => {
    // No `identity.challengeSender` is registered in this describe block yet.
    await setConfig({ registrationMethods: ['email'], emailVerificationRequired: true });
    const email = emailFor('nodriver');

    const config = await app.inject({ method: 'GET', url: '/auth/config' });
    expect((config.json() as Json)['emailVerificationBlocked']).toBe(true);
    expect((config.json() as Json)['emailVerificationRequired']).toBe(false);

    const register = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email, password: 'IntegrationPass123' },
    });
    expect(register.statusCode).toBe(503);
    expect((register.json() as Json)['code']).toBe('auth.email_verification_unavailable');
  });

  it('rejects a weak password without consuming the verification code', async () => {
    app.pluginRuntime.registerExtension('identity.challengeSender', sender, 'test-plugin');
    await setConfig({ registrationMethods: ['email'], emailVerificationRequired: true });
    const email = emailFor('weak');

    const send = await app.inject({
      method: 'POST',
      url: '/register/send-code',
      payload: { email },
    });
    expect(send.statusCode).toBe(202);
    const code = sender.code();

    const weak = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email, password: 'short', code },
    });
    expect(weak.statusCode).toBe(400);
    expect((weak.json() as Json)['code']).toBe('password.too_short');

    // Same code, now with a compliant password: proving the policy check runs
    // before the challenge is spent, so a weak attempt costs the user nothing.
    const ok = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email, password: 'IntegrationPass123', code },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('resets a password end to end, revoking every existing session', async () => {
    await setConfig({ registrationMethods: ['email'] });
    const email = emailFor('reset');
    const oldPassword = 'IntegrationPass123';
    const newPassword = 'ReplacementPass456';

    const registered = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email, password: oldPassword },
    });
    expect(registered.statusCode).toBe(201);
    const token = (registered.json() as { token: string }).token;

    const before = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);

    const forgot = await app.inject({
      method: 'POST',
      url: '/password/forgot',
      payload: { email },
    });
    expect(forgot.statusCode).toBe(202);
    expect((forgot.json() as Json)['sent']).toBe(true);
    const code = sender.code();

    // A wrong code is refused and changes nothing.
    const wrongCode = code === '000000' ? '111111' : '000000';
    const wrong = await app.inject({
      method: 'POST',
      url: '/password/reset',
      payload: { email, code: wrongCode, password: newPassword },
    });
    expect(wrong.statusCode).toBe(400);
    expect((wrong.json() as Json)['code']).toBe('auth.code_invalid');

    // A weak password is refused *before* consumption: the code still works.
    const weak = await app.inject({
      method: 'POST',
      url: '/password/reset',
      payload: { email, code, password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    expect((weak.json() as Json)['code']).toBe('password.too_short');

    const reset = await app.inject({
      method: 'POST',
      url: '/password/reset',
      payload: { email, code, password: newPassword },
    });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as Json)['ok']).toBe(true);

    // The old session is gone: a reset is not a login.
    const stale = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stale.statusCode).toBe(401);

    const withOld = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email, password: oldPassword },
    });
    expect(withOld.statusCode).toBe(401);

    const withNew = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email, password: newPassword },
    });
    expect(withNew.statusCode).toBe(200);
  });

  it('answers a reset request for an unknown address exactly the same way', async () => {
    const unknown = emailFor('unknown');
    const res = await app.inject({
      method: 'POST',
      url: '/password/forgot',
      payload: { email: unknown },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as Json)['sent']).toBe(true);
  });
});
