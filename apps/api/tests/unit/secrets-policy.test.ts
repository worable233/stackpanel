import { describe, expect, it } from 'vitest';
import {
  SECRETS_DISABLED_CODE,
  SECRETS_DISABLED_MESSAGE,
  secretsPolicy,
} from '../../src/lib/secrets-policy.ts';

/**
 * H3: encrypted-secret storage has one explicit enabled/disabled decision.
 * Unset (or blank) means disabled — never a half-enabled state.
 */
describe('secrets policy', () => {
  it('is disabled with a stable reason when the key is unset', () => {
    expect(secretsPolicy(undefined)).toEqual({
      enabled: false,
      reason: SECRETS_DISABLED_MESSAGE,
    });
    expect(SECRETS_DISABLED_CODE).toBe('secret.storage.disabled');
  });

  it('treats a blank key as unset (no half-enable)', () => {
    expect(secretsPolicy('   ').enabled).toBe(false);
    expect(secretsPolicy('').enabled).toBe(false);
  });

  it('is enabled for any non-empty configured key', () => {
    expect(secretsPolicy('a'.repeat(32))).toEqual({ enabled: true });
  });
});
