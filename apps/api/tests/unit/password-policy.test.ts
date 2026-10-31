import { describe, expect, it } from 'vitest';
import { isPluginError } from '@stackpanel/sdk';
import { assertPassword } from '../../src/lib/password-policy.ts';

/**
 * `assertPassword` is the single gate every kernel write path goes through, so
 * the test asserts the *contract* rather than the rule set (which is covered by
 * `packages/sdk/tests/password.test.ts`): refuse with a stable, localisable code.
 */
describe('assertPassword', () => {
  it('accepts a passphrase', () => {
    expect(() => assertPassword('correct-horse-battery-staple')).not.toThrow();
  });

  it('refuses short passwords with the policy code, not a generic error', () => {
    try {
      assertPassword('short');
      throw new Error('expected refusal');
    } catch (error) {
      expect(isPluginError(error)).toBe(true);
      expect((error as { code?: string }).code).toBe('password.too_short');
      expect((error as { status?: number }).status).toBe(400);
    }
  });

  it('refuses a password derived from the address', () => {
    try {
      assertPassword('wolfgang2024', 'wolfgang@example.com');
      throw new Error('expected refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('password.matches_identity');
    }
  });

  it('checks identity only when an email is supplied', () => {
    expect(() => assertPassword('wolfgang2024')).not.toThrow();
  });
});
