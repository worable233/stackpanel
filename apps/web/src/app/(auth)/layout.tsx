import { DocumentScrollbar } from '@stackpanel/ui';
import { isProvisioningMode } from '@/lib/provisioning';
import { activeThemeCandidate } from '@/lib/slots';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // During first boot there is no installed/enabled theme to resolve (and the
  // provision API has no theme endpoints). Skipping the lookup avoids a
  // guaranteed 404 on every render (BOOTSTRAP-R10). Host styles still apply.
  const provisionMode = isProvisioningMode();
  const [theme, t] = await Promise.all([
    provisionMode ? Promise.resolve(null) : activeThemeCandidate(),
    getLocale().then((locale) => createTranslator(locale)),
  ]);
  return (
    <main
      className={
        theme?.id === 'default'
          ? 'clarity-surface relative isolate flex min-h-svh flex-1 bg-background text-foreground [--background:var(--clarity-background)] [--foreground:var(--clarity-foreground)] [--muted:var(--clarity-muted)] [--muted-foreground:var(--clarity-muted-foreground)] [--border:var(--clarity-border)] [--primary:var(--clarity-primary)] [--primary-foreground:var(--clarity-primary-foreground)] [--input:var(--clarity-border)] [--card:var(--clarity-background)] [--card-foreground:var(--clarity-foreground)] [--accent:var(--clarity-muted)] [--accent-foreground:var(--clarity-foreground)] [--ring:var(--clarity-primary)]'
          : 'relative flex min-h-svh flex-1 bg-background text-foreground'
      }
    >
      {children}
      {theme?.id === 'default' ? (
        <DocumentScrollbar
          labels={{ track: t('scrollbar.track'), thumb: t('scrollbar.thumb') }}
        />
      ) : null}
    </main>
  );
}
