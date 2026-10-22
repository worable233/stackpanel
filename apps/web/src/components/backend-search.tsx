'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Search, Sun, Moon, Laptop } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command';
import { useTranslator } from '@/i18n/provider';
import { useTheme } from '@/components/theme-provider';

export function BackendSearch({
  items,
}: {
  items: { href: string; label: string; groupLabel?: string }[];
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const t = useTranslator();
  const { setTheme } = useTheme();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        typeof event.key === 'string' &&
        event.key.toLowerCase() === 'k' &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <>
      <Button
        variant="outline"
        aria-label={t('common.search')}
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setOpen(true)}
        className="h-9 w-full min-w-0 flex-1 justify-start gap-2 rounded-xl border-border/70 bg-muted/25 px-3 text-muted-foreground shadow-none has-[>svg]:px-3 lg:w-44 lg:flex-none 2xl:w-52"
      >
        <Search className="size-4" />
        <span className="truncate">{t('common.search')}</span>
        <kbd className="ml-auto hidden h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] md:inline-flex">
          ⌘ K
        </kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t('common.search')}
        description={t('backendSearch.placeholder')}
        showCloseButton
      >
        <Command key={String(open)}>
          <CommandInput placeholder={t('backendSearch.placeholder')} />
          <CommandList className="max-h-80 p-1">
            <CommandEmpty>{t('backendSearch.empty')}</CommandEmpty>
            <CommandGroup heading={t('backendSearch.pages')}>
              {items.map((item) => (
                <CommandItem
                  key={item.href}
                  value={item.href}
                  keywords={[item.label, item.groupLabel ?? '']}
                  onSelect={() => run(() => router.push(item.href))}
                  className="gap-3 px-3 py-3"
                >
                  <ArrowRight className="text-muted-foreground" />
                  <span>
                    {item.groupLabel ? `${item.groupLabel} › ` : ''}
                    {item.label}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading={t('backendSearch.theme')}>
              {(
                [
                  { value: 'light', Icon: Sun },
                  { value: 'dark', Icon: Moon },
                  { value: 'system', Icon: Laptop },
                ] as const
              ).map(({ value, Icon }) => (
                <CommandItem
                  key={value}
                  value={`theme-${value}`}
                  keywords={[t(`theme.${value}`)]}
                  onSelect={() => run(() => setTheme(value))}
                  className="gap-3 px-3 py-3"
                >
                  <Icon className="text-muted-foreground" />
                  <span>{t(`theme.${value}`)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
