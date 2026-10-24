import { describe, expect, it } from 'vitest';
import { isNextRedirectError } from '@/lib/next-navigation';

describe('isNextRedirectError', () => {
  it('recognises Next redirect control-flow errors', () => {
    expect(isNextRedirectError({ digest: 'NEXT_REDIRECT;replace;/admin;307;' })).toBe(true);
  });

  it('does not misclassify ordinary application errors', () => {
    expect(isNextRedirectError(new Error('鉴权失败'))).toBe(false);
    expect(isNextRedirectError({ digest: 'NEXT_NOT_FOUND' })).toBe(false);
  });
});
