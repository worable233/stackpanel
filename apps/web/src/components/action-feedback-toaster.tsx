'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from '@/components/ui/toast';
import { useTranslator } from '@/i18n/provider';

/** Long errors keep this much inline; the rest folds into a details block. */
const FEEDBACK_PREVIEW_LENGTH = 256;

/**
 * Render a server-action message without silently dropping long ones.
 *
 * Server actions can carry multi-line diagnostics (approval/reconciliation
 * failures). Previously anything over 256 characters was discarded, so the
 * failures that most needed an explanation produced no feedback at all.
 */
function ActionFeedbackDescription({ text }: { text: string }) {
  if (text.length <= FEEDBACK_PREVIEW_LENGTH) return <>{text}</>;
  return (
    <details className="max-w-full text-sm">
      <summary className="cursor-pointer select-none">
        {text.slice(0, FEEDBACK_PREVIEW_LENGTH)}…
      </summary>
      <p className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{text}</p>
    </details>
  );
}

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
  if (error) {
    toast.error(actionFeedbackTitle(action, t), {
      description: <ActionFeedbackDescription text={error} />,
      id: `action-feedback:${action ?? 'unknown'}:${error}`,
    });
  } else if (success) {
    toast.success(actionSuccessTitle(action, t), {
      description: <ActionFeedbackDescription text={success} />,
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
