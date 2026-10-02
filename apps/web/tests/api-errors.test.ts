import { describe, expect, it } from 'vitest';
import { ApiError } from '@stackpanel/sdk';
import { apiErrorMessageFor } from '@/lib/api-errors';

describe('apiErrorMessageFor', () => {
  it('maps a stable error code to the requested locale', () => {
    const error = new ApiError('Incorrect email or password', { status: 400, code: 'auth.invalid_credentials' });
    expect(apiErrorMessageFor('zh-CN', error)).toBe('邮箱或密码错误');
    expect(apiErrorMessageFor('en-US', error)).toBe('Incorrect email or password');
  });

  it('localises a network failure (status 0)', () => {
    const error = new ApiError('network', { status: 0 });
    expect(apiErrorMessageFor('en-US', error)).toBe('Network error, please try again later');
  });

  it('falls back to the server message for an untranslated code', () => {
    const error = new ApiError('Neutral server detail', { status: 400, code: 'plugin.unknown.code' });
    expect(apiErrorMessageFor('en-US', error)).toBe('Neutral server detail');
  });

  it('uses the localised default fallback when there is no message', () => {
    const error = new ApiError('', { status: 400, code: 'plugin.unknown.code' });
    expect(apiErrorMessageFor('en-US', error)).toBe('Operation failed, please try again later');
  });

  it('returns the provided fallback for plain errors', () => {
    expect(apiErrorMessageFor('en-US', new Error('boom'))).toBe('boom');
    expect(apiErrorMessageFor('en-US', 'nope', 'custom')).toBe('custom');
  });
});
