import { afterEach, describe, expect, it } from 'vitest';
import {
  RATE_LIMIT,
  RATE_LIMIT_COVERAGE,
  rateLimitConfig,
  rateLimitMultiplier,
} from '../../src/lib/rate-limit-policy.ts';

/**
 * H2: the rate-limit policy is central and auditable. These tests pin the
 * presets, the coverage contract and the "relax-only" multiplier semantics.
 */
describe('rate-limit policy', () => {
  afterEach(() => {
    delete process.env['API_RATE_LIMIT_MULTIPLIER'];
  });

  it('exposes only well-formed presets', () => {
    for (const [name, rule] of Object.entries(RATE_LIMIT)) {
      expect(rule.max, name).toBeGreaterThan(0);
      expect(typeof rule.timeWindow, name).toBe('string');
    }
  });

  it('declares coverage for every sensitive surface', () => {
    const surfaces = RATE_LIMIT_COVERAGE.map((entry) => entry.surface);
    expect(surfaces.some((s) => s.includes('OAuth'))).toBe(true);
    expect(surfaces.some((s) => s.includes('API Token'))).toBe(true);
    expect(surfaces.some((s) => s.includes('密钥'))).toBe(true);
    expect(surfaces.some((s) => s.includes('上传'))).toBe(true);
    for (const entry of RATE_LIMIT_COVERAGE) {
      expect(RATE_LIMIT[entry.preset]).toBeDefined();
    }
  });

  it('returns the preset verbatim by default', () => {
    expect(rateLimitConfig('oauth')).toEqual({ config: { rateLimit: RATE_LIMIT.oauth } });
  });

  it('multiplier never weakens the policy', () => {
    process.env['API_RATE_LIMIT_MULTIPLIER'] = '0.1';
    expect(rateLimitMultiplier()).toBe(1);
    expect(rateLimitConfig('oauth').config.rateLimit.max).toBe(RATE_LIMIT.oauth.max);

    process.env['API_RATE_LIMIT_MULTIPLIER'] = 'not-a-number';
    expect(rateLimitMultiplier()).toBe(1);
  });

  it('multiplier scales ceilings upward for test / gateway deployments', () => {
    process.env['API_RATE_LIMIT_MULTIPLIER'] = '10';
    expect(rateLimitMultiplier()).toBe(10);
    expect(rateLimitConfig('credentialWrite').config.rateLimit.max).toBe(
      RATE_LIMIT.credentialWrite.max * 10,
    );
    // timeWindow is preserved.
    expect(rateLimitConfig('credentialWrite').config.rateLimit.timeWindow).toBe(
      RATE_LIMIT.credentialWrite.timeWindow,
    );
  });
});
