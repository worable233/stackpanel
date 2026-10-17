'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useTranslator } from '@/i18n/provider';
import { ErrorPage } from '@stackpanel/ui';

/**
 * 用户站点源错误边界（ADR-0011 §6）。页面渲染或数据获取抛错时接管，给出可重试
 * 的失败面板。这个边界是 Client Component（Next 约定），文案走 i18n。
 */
export default function UserError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslator();

  useEffect(() => {
    // i18n-exempt — developer console log, never rendered to the user.
    console.error('[frontend] public site render failed', error);
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
          <Button variant="outline" size="sm" render={<Link href="/" />}>
            {t('common.backHome')}
          </Button>
        </>
      }
    />
  );
}
