'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
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
  /**
   * 初始选中项必须**在首帧就正确**。
   *
   * 原先 `useState(sections[0].id)` 把初始值钉在第一个分区，hash 只在
   * `useEffect` 里读 —— 而 effect 在水合之后才跑。于是直接访问
   * `/admin/settings#payment` 会先画出第一个分区，再跳过去，视觉上就是
   * 「闪一下」。
   *
   * 服务端渲染时读不到 hash（它不参与请求），所以用 `useState` 的惰性初始化
   * 在**客户端首次渲染**时就读：客户端首帧即正确，服务端首帧与之一致的情况
   * （无 hash）不受影响。
   */
  const [active, setActive] = useState(() => initialSectionId(sections));
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
            <SelectTrigger
              className="group/select-trigger h-12 w-full"
              aria-label={label}
              indicator={
                <ChevronRight
                  aria-hidden="true"
                  className="pointer-events-none size-4 text-muted-foreground transition-transform duration-200 ease-out group-data-[popup-open]/select-trigger:rotate-90 motion-reduce:transition-none"
                />
              }
            >
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
          <div id={`settings-panel-${selected.id}`} className="w-full max-w-xl pb-12">
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

/**
 * 从 URL hash 解析初始分区；无 hash 或 hash 无效时退回第一个分区。
 *
 * 导出以便测试：这里错了的表现就是「先闪第一个再跳」。
 */
export function initialSectionId(sections: Array<{ id: string }>): string {
  const fallback = sections[0]?.id ?? '';
  if (typeof window === 'undefined') return fallback;
  const id = window.location.hash.slice(1);
  if (!id) return fallback;
  return sections.some((section) => section.id === id) ? id : fallback;
}
