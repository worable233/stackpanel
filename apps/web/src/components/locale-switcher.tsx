'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { LocaleSwitcher as LocaleSwitcherPrimitive } from '@stackpanel/ui';
import { Globe, Check } from 'lucide-react';
import { BackendToolbarButton } from '@/components/backend-toolbar-button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { setLocaleAction } from '@/i18n/actions';

export interface WebLocaleSwitcherProps {
  locale: string;
  items: { value: string; label: string }[];
  ariaLabel: string;
  iconOnly?: boolean;
}

/**
 * Client binding for the shared `LocaleSwitcher` primitive (ADR-0016 §1).
 *
 * Writes the `sp_locale` cookie through a server action, updates `<html lang>`
 * immediately, then refreshes the route so server components re-read the
 * cookie. The URL is untouched.
 */
export function LocaleSwitcher({
  locale,
  items,
  ariaLabel,
  iconOnly = false,
}: WebLocaleSwitcherProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const changeLocale = (next: string) => {
    startTransition(async () => {
      await setLocaleAction(next);
      document.documentElement.lang = next;
      router.refresh();
    });
  };

  if (iconOnly) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <BackendToolbarButton disabled={pending} aria-label={ariaLabel}>
              <Globe />
            </BackendToolbarButton>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            {items.map((item) => (
              <DropdownMenuItem
                key={item.value}
                onClick={() => changeLocale(item.value)}
                disabled={pending}
              >
                <span>{item.label}</span>
                {item.value === locale ? <Check className="ml-auto size-4" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <LocaleSwitcherPrimitive
      items={items}
      value={locale}
      disabled={pending}
      ariaLabel={ariaLabel}
      onChange={changeLocale}
    />
  );
}
