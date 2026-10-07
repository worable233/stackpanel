'use client';

import { useActionState, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { AuthShell, type AuthProvider } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslator } from '@/i18n/provider';
import { loginAction } from '@/lib/actions';

export function LoginForm({
  nextPath,
  providers = [],
  platformName,
  platformDescription,
  logoSrc,
}: {
  nextPath?: string;
  providers?: AuthProvider[];
  platformName: string;
  platformDescription?: string;
  logoSrc?: string | null;
}) {
  const [state, action, pending] = useActionState(loginAction, {});
  const [showPassword, setShowPassword] = useState(false);
  const t = useTranslator();
  return (
    <AuthShell
      mode="login"
      platformName={platformName}
      platformDescription={platformDescription}
      logoSrc={logoSrc}
      providers={providers}
    >
      <form action={action} className="space-y-5">
        <input type="hidden" name="next" value={nextPath ?? ''} />
        <div className="space-y-2">
          <Label htmlFor="email">{t('auth.login.email')}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="py-2.5"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t('auth.login.password')}</Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              className="py-2.5 pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        <Button type="submit" disabled={pending} className="h-10 w-full text-base">
          {pending ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
