'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslator } from '@/i18n/provider';

const MAX_ACTION_ERROR_LENGTH = 256;

/** Surface one server-action failure through the shared backend toaster. */
function ActionFeedbackToastContent() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslator();
  const query = searchParams.toString();

  useEffect(() => {
    const params = new URLSearchParams(query);
  const error = params.get('error');
  const success = params.get('success');
    const action = params.get('action');
  if (error && error.length <= MAX_ACTION_ERROR_LENGTH) {
    toast.error(actionFeedbackTitle(action, t), {
      description: error,
      id: `action-feedback:${action ?? 'unknown'}:${error}`,
    });
  } else if (success && success.length <= MAX_ACTION_ERROR_LENGTH) {
    toast.success(actionSuccessTitle(action, t), {
      description: success,
      id: `action-success:${action ?? 'unknown'}:${success}`,
    });
  } else {
    return;
  }

    params.delete('action');
    params.delete('error');
  params.delete('success');
    const next = params.toString();
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [pathname, query, router, t]);

  return null;
}

/** The shell is static in some deployments, so isolate query access behind Suspense. */
export function ActionFeedbackToaster() {
  return (
    <Suspense fallback={null}>
      <ActionFeedbackToastContent />
    </Suspense>
  );
}

export function actionFeedbackTitle(action: string | null, t: (key: string) => string): string {
  if (action === 'zjmf-upstream.sync') return t('action.feedback.upstreamSyncFailed');
  if (action === 'zjmf-upstream.create') return t('action.feedback.upstreamCreateFailed');
  if (action === 'zjmf-upstream.delete') return t('action.feedback.upstreamDeleteFailed');
  return t('action.feedback.failed');
}

export function actionSuccessTitle(action: string | null, t: (key: string) => string): string {
  if (action === 'zjmf-upstream.sync') return t('action.feedback.upstreamSyncSucceeded');
  return t('action.feedback.succeeded');
}
