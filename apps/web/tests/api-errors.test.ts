import { describe, expect, it } from 'vitest';
import { ApiError } from '@stackpanel/sdk';
import { apiErrorMessageFor, apiErrorViewFor } from '@/lib/api-errors';

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

  it('never leaks the server message for an untranslated code', () => {
    const error = new ApiError('Neutral server detail', { status: 400, code: 'plugin.unknown.code' });
    expect(apiErrorMessageFor('en-US', error)).toBe('Operation failed, please try again later');
  });

  it('uses the localised default fallback when there is no message', () => {
    const error = new ApiError('', { status: 400, code: 'plugin.unknown.code' });
    expect(apiErrorMessageFor('en-US', error)).toBe('Operation failed, please try again later');
  });

  it('carries the code and the remaining wait so a form can act on it', () => {
    // A 429 that only yields a sentence is a dead end: the form cannot tell
    // "unlock the resend button and count down 43s" from "this is broken".
    const throttled = new ApiError('Too many codes', {
      status: 429,
      code: 'auth.code_cooldown',
      retryAfterSeconds: 43,
    });
    const view = apiErrorViewFor('zh-CN', throttled);
    expect(view.error).toBe('验证码发送过于频繁，请 43 秒后重试');
    expect(view.code).toBe('auth.code_cooldown');
    expect(view.retryAfterSeconds).toBe(43);

    // Older servers/proxies omit the wait: still localised, just without a timer.
    const bare = new ApiError('Too many codes', { status: 429, code: 'auth.code_quota_exceeded' });
    const bareView = apiErrorViewFor('zh-CN', bare);
    expect(bareView.error).toContain('一小时');
    expect(bareView.retryAfterSeconds).toBeUndefined();
  });

  it('does not render raw exception text', () => {
    expect(apiErrorMessageFor('en-US', new Error('boom'))).toBe(
      'Operation failed, please try again later',
    );
    expect(apiErrorMessageFor('en-US', new Error('fetch failed'), 'custom fallback')).toBe(
      'custom fallback',
    );
    expect(apiErrorMessageFor('en-US', 'nope', 'custom')).toBe('custom');
  });
});
