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

describe('ApiErrorView.detail (安装失败的子原因)', () => {
  /**
   * 线上形态：市场安装失败时界面只有「安装失败，请稍后再试」，用户分不清是下载、
   * sha256、验签、解包还是启动失败。服务端其实已经在 problem-details 的 `detail`
   * 里给了子原因，但 `ApiErrorView` 只保留本地化文案，把它丢了。
   */
  it('forwards the server detail so the UI can show a collapsible reason', () => {
    const error = new ApiError('market.packageInvalid', {
      status: 502,
      code: 'market.packageInvalid',
      details: { detail: 'invalid_archive: missing plugin.json' },
    });
    const view = apiErrorViewFor('en-US', error);
    // 精确错误码有自己的文案；`detail` 是**补充**而不是替代。
    expect(view.error).toBe('Catalog package does not match its entry or is malformed. Install rejected.');
    expect(view.detail).toBe('invalid_archive: missing plugin.json');
  });

  it('keeps the localised sentence free of the raw detail', () => {
    // `detail` 是英文技术文本，默认不上屏；拼进 error 会破坏本地化并泄露内部标识。
    const error = new ApiError('market.trustRootMissing', {
      status: 422,
      code: 'market.trustRootMissing',
      details: { detail: '信任根缺少 keyId pkg-2026-11' },
    });
    const view = apiErrorViewFor('zh-CN', error);
    expect(view.error).not.toContain('keyId');
    expect(view.detail).toContain('keyId');
  });

  it('ignores a non-string or blank detail instead of stringifying it', () => {
    const objectDetail = new ApiError('x', { status: 400, code: 'c', details: { detail: { a: 1 } } });
    expect(apiErrorViewFor('en-US', objectDetail).detail).toBeUndefined();

    const blank = new ApiError('x', { status: 400, code: 'c', details: { detail: '   ' } });
    expect(apiErrorViewFor('en-US', blank).detail).toBeUndefined();

    const missing = new ApiError('x', { status: 400, code: 'c', details: ['field error'] });
    expect(apiErrorViewFor('en-US', missing).detail).toBeUndefined();

    const noDetails = new ApiError('x', { status: 400, code: 'c' });
    expect(apiErrorViewFor('en-US', noDetails).detail).toBeUndefined();
  });
});
