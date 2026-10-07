import { describe, expect, it } from 'vitest';
import { isSafeUrl, sanitizeRichText } from '../../src/media/sanitize.ts';
import { sanitizeRichText as sdkSanitize } from '@stackpanel/sdk/sanitize';

/**
 * The kernel's `media/sanitize` module is a thin re-export of the canonical SDK
 * implementation (ADR-0014 §5), so plugins and the kernel share one policy. The
 * policy itself is covered by `@stackpanel/sdk` tests; here we only assert the
 * wiring so a future refactor cannot silently fork the two.
 */
describe('media sanitize re-export', () => {
  it('is the SDK implementation, not a fork', () => {
    expect(sanitizeRichText).toBe(sdkSanitize);
  });

  it('exposes isSafeUrl from the SDK', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('/local/path')).toBe(true);
  });
});
