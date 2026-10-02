'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useTranslator } from '@/i18n/provider';

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
    console.error('[frontend] 用户站点源渲染失败', error);
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm rounded-lg border bg-card p-6 text-center text-card-foreground shadow-sm">
        <p className="text-sm font-medium">{t('frontendError.title')}</p>
        <p className="mt-2 text-sm text-muted-foreground">{t('frontendError.description')}</p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button variant="default" size="sm" onClick={() => reset()}>
            {t('common.retry')}
          </Button>
          <Button variant="outline" size="sm" render={<Link href="/" />}>
            {t('common.backHome')}
          </Button>
        </div>
      </div>
    </main>
  );
}
