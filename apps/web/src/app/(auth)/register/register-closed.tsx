'use client';

import Link from 'next/link';
import { AuthShell } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { useTranslator } from '@/i18n/provider';

/**
 * Shown instead of the sign-up form when registration cannot succeed.
 *
 * Copy is resolved by the server component (it already knows the locale and the
 * reason) so this stays a dumb presentational component with no policy logic.
 */
export function RegisterClosed({
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
    <AuthShell mode="register" platformName={platformName} logoSrc={logoSrc}>
      <div className="space-y-4 text-center">
        <p className="text-base font-medium text-foreground">{title}</p>
        <p className="text-sm leading-6 text-muted-foreground">{body}</p>
        <Button
          className="h-10 w-full text-base"
          nativeButton={false}
          render={<Link href="/login" />}
        >
          {t('auth.register.login')}
        </Button>
      </div>
    </AuthShell>
  );
}
