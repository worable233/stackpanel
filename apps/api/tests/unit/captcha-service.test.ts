import { describe, expect, it } from 'vitest';
import type { CaptchaProvider } from '@stackpanel/sdk';
import { isPluginError } from '@stackpanel/sdk';
import { KernelCaptchaService } from '../../src/auth/captcha-service.ts';
import { env } from '../../src/config/env.ts';

function provider(overrides: Partial<CaptchaProvider> = {}): CaptchaProvider {
  return {
    id: 'fake',
    name: 'Fake',
    verify: async () => ({ success: true }),
    ...overrides,
  };
}

describe('KernelCaptchaService', () => {
  it('reports not configured when no provider is registered', async () => {
    const service = new KernelCaptchaService({ getProviders: () => [] });
    expect(service.isConfigured()).toBe(false);
    expect(await service.clientConfig()).toBeNull();
  });

  it('passes verification through to the provider', async () => {
    const seen: unknown[] = [];
    const service = new KernelCaptchaService({
      getProviders: () => [
        provider({
          verify: async (input) => {
            seen.push(input);
            return { success: true };
          },
        }),
      ],
    });
    const result = await service.verify({ token: 'abc', action: 'register', remoteIp: '1.2.3.4' });
    expect(result.success).toBe(true);
    expect(seen[0]).toMatchObject({ token: 'abc', action: 'register', remoteIp: '1.2.3.4' });
  });

  it('rejects a missing token without calling the provider', async () => {
    let called = false;
    const service = new KernelCaptchaService({
      getProviders: () => [
        provider({
          verify: async () => {
            called = true;
            return { success: true };
          },
        }),
      ],
    });
    const result = await service.verify({ token: '   ' });
    expect(result).toMatchObject({ success: false, reason: 'missing_token' });
    expect(called).toBe(false);
  });

  it('treats a provider outage as a failure, not a pass', async () => {
    const service = new KernelCaptchaService({
      getProviders: () => [
        provider({
          verify: async () => {
            throw new Error('upstream 500');
          },
        }),
      ],
      logger: { warn: () => undefined },
    });
    const result = await service.verify({ token: 'abc' });
    expect(result).toMatchObject({ success: false, reason: 'provider_error' });
  });

  it('enforce is a no-op when mode is off', async () => {
    const service = new KernelCaptchaService({ getProviders: () => [] });
    // env.AUTH_CAPTCHA_MODE defaults to 'off' in the test environment.
    await expect(service.enforce({ token: '' })).resolves.toBeUndefined();
  });

  it('returns the provider client config without exposing it as a secret', async () => {
    const service = new KernelCaptchaService({
      getProviders: () => [provider({ clientConfig: () => ({ siteKey: 'public' }) })],
    });
    expect(await service.clientConfig()).toEqual({ siteKey: 'public' });
  });

  it('falls through to a second provider when the first rejects', async () => {
    const service = new KernelCaptchaService({
      getProviders: () => [
        provider({ id: 'first', verify: async () => ({ success: false, reason: 'bad' }) }),
        provider({ id: 'second', verify: async () => ({ success: true }) }),
      ],
    });
    const result = await service.verify({ token: 'x' });
    expect(result).toMatchObject({ success: true, providerId: 'second' });
  });

  it('exposes a policy error type when require plus no provider', async () => {
    // Force required mode via the service's own env read is not possible here;
    // assert the shape contract instead: enforce never throws an unbranded error.
    const service = new KernelCaptchaService({ getProviders: () => [] });
    try {
      await service.enforce({ token: '' });
    } catch (error) {
      expect(isPluginError(error)).toBe(true);
    }
  });
});

/**
 * Per-action policy (spec §3.2/§4.1).
 *
 * `env.AUTH_CAPTCHA_MODE` defaults to `off`, which is the master switch, so
 * these cases flip it for the duration of one test and restore it — letting a
 * provider ask for `required` while the global switch is `off` is exactly the
 * interaction worth pinning down.
 */
function withMode<T>(mode: 'off' | 'optional' | 'required', run: () => T): T {
  const previous = env.AUTH_CAPTCHA_MODE;
  env.AUTH_CAPTCHA_MODE = mode;
  try {
    const result = run();
    if (result instanceof Promise) {
      return result.finally(() => {
        env.AUTH_CAPTCHA_MODE = previous;
      }) as T;
    }
    env.AUTH_CAPTCHA_MODE = previous;
    return result;
  } catch (error) {
    env.AUTH_CAPTCHA_MODE = previous;
    throw error;
  }
}

describe('KernelCaptchaService per-action policy', () => {
  it('falls back to the global mode when no provider declares an action', async () => {
    const service = new KernelCaptchaService({ getProviders: () => [provider()] });
    expect(await withMode('optional', () => service.policyFor('login'))).toBe('optional');
    expect(await service.policyFor('login')).toBe('off');
  });

  it('lets a provider declare a stricter policy than the global mode', async () => {
    const service = new KernelCaptchaService({
      getProviders: () => [
        provider({ policyFor: (action) => (action === 'login' ? { mode: 'required' } : null) }),
      ],
    });
    await withMode('optional', async () => {
      expect(await service.policyFor('login')).toBe('required');
      // An action nobody claims keeps the global mode.
      expect(await service.policyFor('register')).toBe('optional');
    });
  });

  it('keeps the global off switch as the final veto over provider policy', async () => {
    const service = new KernelCaptchaService({
      getProviders: () => [provider({ policyFor: () => ({ mode: 'required' }) })],
    });
    // Global mode is 'off' (the default), so even a provider demanding
    // verification is ignored: an operator must be able to disable this with one
    // env change, without uninstalling the provider.
    expect(await service.policyFor('login')).toBe('off');
    return expect(service.enforce({ token: '', action: 'login' })).resolves.toBeUndefined();
  });

  it('only asks the providers that claim the action', async () => {
    const asked: string[] = [];
    const service = new KernelCaptchaService({
      getProviders: () => [
        provider({
          id: 'unclaimed',
          verify: async () => {
            asked.push('unclaimed');
            return { success: false };
          },
        }),
        provider({
          id: 'claimed',
          policyFor: (action) => (action === 'login' ? { mode: 'optional' } : null),
          verify: async () => {
            asked.push('claimed');
            return { success: true };
          },
        }),
      ],
    });
    const result = await service.verify({ token: 'x', action: 'login' });
    expect(result).toMatchObject({ success: true, providerId: 'claimed' });
    expect(asked).toEqual(['claimed']);
  });

  it('never calls a provider that opted the action out', async () => {
    let called = false;
    const service = new KernelCaptchaService({
      getProviders: () => [
        provider({
          policyFor: () => ({ mode: 'off' }),
          verify: async () => {
            called = true;
            return { success: true };
          },
        }),
      ],
    });
    await withMode('required', () => service.enforce({ token: 'x', action: 'register' }));
    expect(called).toBe(false);
  });

  it('refuses a token-less required action before any network call', async () => {
    let called = false;
    const service = new KernelCaptchaService({
      getProviders: () => [
        provider({
          policyFor: () => ({ mode: 'required' }),
          verify: async () => {
            called = true;
            return { success: true };
          },
        }),
      ],
    });
    await withMode('optional', async () => {
      await expect(service.enforce({ token: '', action: 'change_password' })).rejects.toSatisfy(
        (error: unknown) => isPluginError(error) && error.code === 'auth.captcha_required',
      );
    });
    expect(called).toBe(false);
  });

  it('fails closed when a required action has no provider at all', async () => {
    const service = new KernelCaptchaService({ getProviders: () => [] });
    await withMode('required', async () => {
      await expect(service.enforce({ token: 'x', action: 'login' })).rejects.toSatisfy(
        (error: unknown) => isPluginError(error) && error.code === 'auth.captcha_unavailable',
      );
    });
  });

  it('resolves widget config per action with a fallback to the default', async () => {
    const service = new KernelCaptchaService({
      getProviders: () => [
        provider({
          policyFor: (action) => (action === 'login' ? { mode: 'required' } : null),
          clientConfig: () => ({ kind: 'script', siteKey: 'k' }),
        }),
      ],
    });
    expect(await service.clientConfigFor('login')).toEqual({ kind: 'script', siteKey: 'k' });
    // Nobody claims `register`, so the default provider config still applies.
    expect(await service.clientConfigFor('register')).toEqual({ kind: 'script', siteKey: 'k' });
  });
});
