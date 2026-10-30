'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface SettingsSection {
  id: string;
  title: string;
  Icon: LucideIcon;
  content: ReactNode;
}

/** Shared settings navigation; inactive panels unmount so credentials stay local to their form. */
export function SettingsSections({
  sections,
  label,
}: {
  sections: SettingsSection[];
  label: string;
}) {
  const [active, setActive] = useState(sections[0]?.id ?? '');
  const ids = sections.map(({ id }) => id).join(',');
  useEffect(() => {
    const sync = () => {
      const id = window.location.hash.slice(1);
      if (ids.split(',').includes(id)) setActive(id);
    };
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, [ids]);
  const selected = sections.find(({ id }) => id === active) ?? sections[0];
  function select(id: string) {
    setActive(id);
    window.history.replaceState(null, '', `#${id}`);
  }
  return (
    <Tabs
      value={selected?.id}
      onValueChange={select}
      orientation="vertical"
      className="flex min-w-0 flex-col gap-6 lg:flex-row lg:gap-6"
    >
      <aside className="shrink-0 lg:w-40 lg:pt-1">
        <div className="md:hidden">
          <Select value={selected?.id} onValueChange={(value) => value && select(value)}>
            <SelectTrigger className="h-12 w-full" aria-label={label}>
              <SelectValue>{selected?.title}</SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {sections.map(({ id, title }) => (
                  <SelectItem key={id} value={id}>
                    {title}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <TabsList
          aria-label={label}
          className="scrollbar-none hidden h-auto w-full flex-col gap-1 overflow-x-auto rounded-none bg-transparent p-0 md:flex lg:overflow-visible"
        >
          {sections.map(({ id, title, Icon }) => (
            <TabsTrigger
              key={id}
              value={id}
              aria-controls={`settings-panel-${id}`}
              className={cn(
                'h-10 w-full flex-none justify-start gap-3 rounded-lg px-3 text-sm font-normal whitespace-nowrap text-muted-foreground data-active:bg-muted data-active:font-medium data-active:text-foreground after:hidden hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <Icon className="size-4" />
              {title}
            </TabsTrigger>
          ))}
        </TabsList>
      </aside>
      <TabsContent value={selected?.id ?? ''} className="min-w-0 flex-1 p-1">
        {selected && (
          <div
            id={`settings-panel-${selected.id}`}
            className="w-full max-w-xl pb-12"
          >
            {selected.content}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

export function SettingsSelect({
  id,
  value,
  onChange,
  options,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(value) => value !== null && onChange(value)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue>{options.find(([key]) => key === value)?.[1] ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {options.map(([key, label]) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
