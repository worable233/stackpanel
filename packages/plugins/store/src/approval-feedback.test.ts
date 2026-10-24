import { describe, expect, it } from 'vitest';
import { approvalErrorMessage } from '../frontend/src/approval-feedback';

describe('approval response feedback', () => {
  it.each([
    { error: '缺少原请求的持久化账单证据' },
    { detail: '缺少原请求的持久化账单证据' },
    { message: '缺少原请求的持久化账单证据' },
    { error: { message: '缺少原请求的持久化账单证据' } },
  ])('preserves actionable errors in supported host formats', body => {
    expect(approvalErrorMessage(body, '失败')).toBe('缺少原请求的持久化账单证据');
  });
  it('does not render unknown objects', () => {
    expect(approvalErrorMessage({ error: { unexpected: true } }, '失败')).toBe('失败');
    expect(approvalErrorMessage(null, '失败')).toBe('失败');
  });
});
