'use client';

import { Check, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
import { backendToolbarButtonClass } from '@/components/backend-toolbar-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTranslator } from '@/i18n/provider';

/** Light / dark / system theme switcher. */
export function ThemeToggle({
  variant = 'outline',
  toolbar = false,
}: {
  variant?: 'outline' | 'ghost';
  toolbar?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const t = useTranslator();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={variant}
            className={toolbar ? backendToolbarButtonClass : undefined}
            size="icon"
            aria-label={t('theme.toggleAriaLabel')}
          />
        }
      >
        <Sun className="size-4 dark:hidden" />
        <Moon className="hidden size-4 dark:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          {t('theme.light')}
          {theme === 'light' ? <Check className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          {t('theme.dark')}
          {theme === 'dark' ? <Check className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          {t('theme.system')}
          {theme === 'system' ? <Check className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
