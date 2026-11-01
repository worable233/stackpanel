import { describe, expect, it } from 'vitest';
import { actionFeedbackTitle, actionSuccessTitle } from '@/components/action-feedback-toaster';
import {
  ACTION_FEEDBACK_CODES,
  feedbackCodeForAction,
  isFeedbackCode,
  isFlashToken,
  resolveActionFeedback,
  successCodeForAction,
} from '@/lib/action-feedback-codes';
import { stripFeedbackParams, HOST_FEEDBACK_PARAMS } from '@/lib/feedback-params';

const translate = (key: string) => `translated:${key}`;

describe('action feedback toaster', () => {
  it('names the failed ZJMF action instead of showing a generic error', () => {
    expect(actionFeedbackTitle('zjmf-upstream.sync', translate)).toBe(
      'translated:action.feedback.upstreamSyncFailed',
    );
  });

  it('uses a generic title for other plugin actions', () => {
    expect(actionFeedbackTitle('other-plugin.save', translate)).toBe(
      'translated:action.feedback.failed',
    );
  });

  it('names a successful ZJMF sync instead of showing a generic success', () => {
    expect(actionSuccessTitle('zjmf-upstream.sync', translate)).toBe(
      'translated:action.feedback.upstreamSyncSucceeded',
    );
  });

  it('never renders an unknown action id from the URL', () => {
    // `action` 也来自 URL：只允许精确匹配，未知值落到通用文案。
    const injected = '<img src=x onerror=alert(1)>';
    expect(actionFeedbackTitle(injected, translate)).toBe('translated:action.feedback.failed');
    expect(actionSuccessTitle(injected, translate)).toBe('translated:action.feedback.succeeded');
  });
});

describe('URL 反馈通道只接受 code', () => {
  it('translates a registered code', () => {
    const feedback = resolveActionFeedback('zh-CN', 'success', 'upstreamSyncSucceeded');
    expect(feedback).toMatchObject({ known: true, code: 'upstreamSyncSucceeded' });
    expect(feedback?.text).toContain('同步');
  });

  it('drops attacker-supplied prose instead of rendering it', () => {
    // 攻击场景：把任意话术塞进 `?success=`，让站内 toast 替它背书。
    const phishing = '安装成功！请在此处重新输入管理员密码：https://evil.test';
    const feedback = resolveActionFeedback('zh-CN', 'success', phishing);
    expect(feedback).not.toBeNull();
    expect(feedback?.known).toBe(false);
    // 文案来自本地词表，**不包含**注入的原文。
    expect(feedback?.text).not.toContain('evil.test');
    expect(feedback?.text).not.toContain('管理员密码');
    // 原文只在 code 位显示为一个「未登记」标记，不整句渲染。
    expect(feedback?.code).toBe('invalid');
  });

  it('keeps an unregistered but well-formed code visible for debugging', () => {
    const feedback = resolveActionFeedback('zh-CN', 'error', 'some-plugin.newFailure');
    expect(feedback).toMatchObject({ known: false, code: 'some-plugin.newFailure' });
    expect(feedback?.text).toBe('操作失败');
  });

  it('rejects control characters, newlines and over-long values', () => {
    expect(resolveActionFeedback('zh-CN', 'error', 'bad\nvalue')?.known).toBe(false);
    expect(resolveActionFeedback('zh-CN', 'error', 'a'.repeat(65))?.known).toBe(false);
    expect(isFeedbackCode('a'.repeat(64))).toBe(true);
  });

  it('returns null for an absent parameter', () => {
    expect(resolveActionFeedback('zh-CN', 'error', null)).toBeNull();
    expect(resolveActionFeedback('zh-CN', 'error', '')).toBeNull();
  });

  it('keeps the code whitelist in sync with the action ids it serves', () => {
    for (const code of ACTION_FEEDBACK_CODES) expect(isFeedbackCode(code)).toBe(true);
    expect(feedbackCodeForAction('zjmf-upstream.create')).toBe('upstreamCreateFailed');
    expect(feedbackCodeForAction(null)).toBe('failed');
    expect(successCodeForAction(null)).toBe('succeeded');
  });
});

describe('一次性 flash token', () => {
  it('accepts uuid-shaped tokens and rejects prose', () => {
    expect(isFlashToken('3f9a1c2e-8b7d-4c5a-9e1f-2a3b4c5d6e7f')).toBe(true);
    expect(isFlashToken('已保存')).toBe(false);
    expect(isFlashToken('short')).toBe(false);
  });
});

describe('插件页面拿不到宿主反馈参数', () => {
  it('strips error / success / flash / action and keeps everything else', () => {
    const stripped = stripFeedbackParams({
      error: 'anything at all',
      success: 'succeeded',
      flash: '3f9a1c2e-8b7d-4c5a-9e1f-2a3b4c5d6e7f',
      action: 'store.save',
      panel: 'overview',
      orderId: '42',
      gone: undefined,
    });
    expect(stripped).toEqual({ panel: 'overview', orderId: '42' });
    for (const key of HOST_FEEDBACK_PARAMS) expect(stripped).not.toHaveProperty(key);
  });
});
