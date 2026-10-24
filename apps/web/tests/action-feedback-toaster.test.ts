import { describe, expect, it } from 'vitest';
import { actionFeedbackTitle, actionSuccessTitle } from '@/components/action-feedback-toaster';

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
});
