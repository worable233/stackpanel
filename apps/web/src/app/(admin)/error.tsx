'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useTranslator } from '@/i18n/provider';
import { ErrorPage } from '@stackpanel/ui';

/**
 * Admin shell source error boundary (ADR-0011 §6).
 *
 * `(admin)` previously had no `error.tsx`, so a render/data failure bubbled to
 * the root boundary and dropped the user out of the console shell. This keeps
 * the admin chrome and offers retry / back-to-console actions. The raw exception
 * is logged for operators and never rendered.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslator();

  useEffect(() => {
    // i18n-exempt — developer console log, never rendered to the user.
    console.error('[frontend] admin render failed', error);
  }, [error]);

  return (
    <ErrorPage
      kind="server-error"
      content={{
        title: t('errorPage.serverError.title'),
        description: t('errorPage.serverError.description'),
      }}
      actions={
        <>
          <Button variant="default" size="sm" onClick={() => reset()}>
            {t('common.retry')}
          </Button>
          <Button variant="outline" size="sm" render={<Link href="/admin" />}>
            {t('common.backHome')}
          </Button>
        </>
      }
    />
  );
}
