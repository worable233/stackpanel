'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { LocaleSwitcher as LocaleSwitcherPrimitive } from '@stackpanel/ui';
import { setLocaleAction } from '@/i18n/actions';

export interface WebLocaleSwitcherProps {
  locale: string;
  items: { value: string; label: string }[];
  ariaLabel: string;
}

/**
 * Client binding for the shared `LocaleSwitcher` primitive (ADR-0016 §1).
 *
 * Writes the `sp_locale` cookie through a server action, updates `<html lang>`
 * immediately, then refreshes the route so server components re-read the
 * cookie. The URL is untouched.
 */
export function LocaleSwitcher({ locale, items, ariaLabel }: WebLocaleSwitcherProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <LocaleSwitcherPrimitive
      items={items}
      value={locale}
      disabled={pending}
      ariaLabel={ariaLabel}
      onChange={(next) => {
        startTransition(async () => {
          await setLocaleAction(next);
          document.documentElement.lang = next;
          router.refresh();
        });
      }}
    />
  );
}
