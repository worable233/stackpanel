'use client';

import Link from 'next/link';
import { AuthShell } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { useTranslator } from '@/i18n/provider';

/**
 * Terminal state for "this deployment cannot send mail": a form here could never
 * succeed, so the page explains the situation instead of failing on submit.
 */
export function ResetUnavailable({
  platformName,
  logoSrc,
  title,
  body,
}: {
  platformName: string;
  logoSrc?: string | null;
  title: string;
  body: string;
}) {
  const t = useTranslator();
  return (
    <AuthShell mode="reset" platformName={platformName} logoSrc={logoSrc}>
      <div className="space-y-4 text-center">
        <p className="text-base font-medium text-foreground">{title}</p>
        <p className="text-sm leading-6 text-muted-foreground">{body}</p>
        <Button
          className="h-10 w-full text-base"
          nativeButton={false}
          render={<Link href="/login" />}
        >
          {t('auth.reset.backToLogin')}
        </Button>
      </div>
    </AuthShell>
  );
}
