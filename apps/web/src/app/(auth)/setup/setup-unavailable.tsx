'use client';

import { useState } from 'react';
import { Layers, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslator } from '@/i18n/provider';

/**
 * Fallback when `GET /setup/status` could not be read at all (BOOTSTRAP-R1).
 *
 * The previous behaviour redirected to `/login`, which is unreachable on a
 * fresh instance and made a transient API failure look like "already
 * installed". A retryable message is both more honest and more useful.
 */
export function SetupUnavailable() {
  const t = useTranslator();
  // `retrying` only disables the button while the reload is in flight; the
  // component unmounts with the page, so no reset effect is needed.
  const [retrying, setRetrying] = useState(false);

  return (
    <div className="relative isolate flex min-h-svh w-full flex-col overflow-x-clip">
      <header className="mx-auto flex w-full max-w-5xl items-center gap-2.5 px-6 py-7 font-medium tracking-tight sm:px-10">
        <Layers className="size-7 text-primary" aria-hidden />
        <span>StackPanel</span>
      </header>

      <div className="mx-auto flex w-full max-w-md flex-1 items-center px-6 py-12">
        <section className="w-full" aria-labelledby="setup-unavailable-heading">
          <h1
            id="setup-unavailable-heading"
            className="mb-4 text-2xl font-medium tracking-tight"
          >
            {t('auth.setup.unavailable.title')}
          </h1>
          <p className="mb-8 text-sm text-muted-foreground">
            {t('auth.setup.unavailable.description')}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              // A full reload re-runs the server component and re-reads status.
              window.location.reload();
            }}
          >
            <RefreshCw className={retrying ? 'animate-spin' : undefined} aria-hidden />
            {t('auth.setup.unavailable.retry')}
          </Button>
        </section>
      </div>
    </div>
  );
}
