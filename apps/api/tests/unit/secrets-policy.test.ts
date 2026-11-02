import { describe, expect, it } from 'vitest';
import {
  SECRETS_DISABLED_CODE,
  SECRETS_DISABLED_MESSAGE,
  pluginsAffectedBySecret,
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

  it('maps a plugin-scoped key to the plugin that reads it', () => {
    // This is the fix for 「配置页说已保存，支付却一直报未配置」: writing the
    // secret must reload the plugin whose `onActivate` reads it.
    expect(pluginsAffectedBySecret('plugin.epay.gateway-config')).toEqual(['epay']);
    expect(pluginsAffectedBySecret('plugin.zjmf-upstream.credentials.abc')).toEqual([
      'zjmf-upstream',
    ]);
  });

  it('ignores kernel-owned and malformed keys instead of reloading something', () => {
    // The kernel reads its own secrets per request (`agent.llm.apiKey`), so a
    // reload here would be a pointless plugin restart.
    expect(pluginsAffectedBySecret('agent.llm.apiKey')).toEqual([]);
    expect(pluginsAffectedBySecret('plugin.epay')).toEqual([]);
    expect(pluginsAffectedBySecret('plugin..key')).toEqual([]);
    expect(pluginsAffectedBySecret('plugin.EPAY.key')).toEqual([]);
    expect(pluginsAffectedBySecret('plugin.epay.a b')).toEqual([]);
  });
});
