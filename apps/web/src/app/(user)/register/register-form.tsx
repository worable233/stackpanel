'use client';

import { useActionState, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { AuthShell, type AuthProvider } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslator } from '@/i18n/provider';
import { registerAction } from '@/lib/actions';

export function RegisterForm({
  providers = [],
  platformName,
  platformDescription,
  logoSrc,
}: {
  providers?: AuthProvider[];
  platformName: string;
  platformDescription?: string;
  logoSrc?: string | null;
}) {
  const [state, action, pending] = useActionState(registerAction, {});
  const [showPassword, setShowPassword] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const t = useTranslator();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const password = (form.elements.namedItem('password') as HTMLInputElement | null)?.value;
    const confirm = (form.elements.namedItem('confirmPassword') as HTMLInputElement | null)?.value;
    if (password !== confirm) {
      event.preventDefault();
      setConfirmError(t('auth.validation.passwordMismatch'));
      return;
    }
    setConfirmError(null);
  }

  return (
    <AuthShell
      mode="register"
      platformName={platformName}
      platformDescription={platformDescription}
      logoSrc={logoSrc}
      providers={providers}
    >
      <form action={action} onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="email">{t('auth.register.email')}</Label>
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
          <Label htmlFor="password">{t('auth.register.password')}</Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              minLength={8}
              className="py-2.5 pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={
                showPassword ? t('auth.register.hidePassword') : t('auth.register.showPassword')
              }
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">{t('auth.register.confirmPassword')}</Label>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            className="py-2.5"
            aria-invalid={confirmError ? true : undefined}
          />
        </div>
        {confirmError ? <p className="text-sm text-destructive">{confirmError}</p> : null}
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        <Button type="submit" disabled={pending} className="h-10 w-full text-base">
          {pending ? t('auth.register.submitting') : t('auth.register.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
