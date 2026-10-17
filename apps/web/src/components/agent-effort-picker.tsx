'use client';

import { ChevronDown, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

const levels = [
  { value: '快速', label: 'Low', accessible: '低' },
  { value: '均衡', label: 'Medium', accessible: '中' },
  { value: '深入', label: 'High', accessible: '高' },
  { value: '极高', label: 'Extra high', accessible: '极高' },
] as const;

export function AgentEffortPicker({ value, onChange, disabled, modelLabel = '默认模型' }: {
  value: string; onChange: (value: string) => void; disabled?: boolean; modelLabel?: string;
}) {
  const index = Math.max(0, levels.findIndex((level) => level.value === value));
  const selected = levels[index] ?? levels[1];
  return <Popover>
      <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled} className="gap-1.5 rounded-full px-2.5 font-normal" aria-label="模型与思考强度" />}>
        <span className="max-w-24 truncate">{modelLabel}</span><span className="text-muted-foreground">{selected.label}</span><ChevronDown data-icon="inline-end" className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={10} className="w-72 max-w-[calc(100vw-1.5rem)] gap-0 rounded-[20px] border border-foreground/15 bg-popover p-3.5 shadow-xl shadow-foreground/10 ring-0 [--primary:var(--clarity-primary,var(--ring))]">
        <div className="relative flex flex-col items-center gap-0.5 pb-4">
          <PopoverTitle className="text-base font-medium text-primary">{selected.label}</PopoverTitle>
          <span className="max-w-[80%] truncate text-sm text-muted-foreground">{modelLabel}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="重置思考强度" onClick={() => onChange('均衡')} className="absolute -right-0.5 -top-0.5 rounded-full text-muted-foreground"><RotateCcw /></Button>
        </div>
        <div className="relative py-0.5">
          <Slider min={0} max={3} step={1} value={[index]} onValueChange={(next) => {
            const position = Array.isArray(next) ? next[0] : next;
            onChange((levels[position ?? 1] ?? levels[1]).value);
          }} thumbAlignment="edge" thumbProps={{ 'aria-label': '思考强度', 'aria-valuetext': selected.accessible }}
            trackClassName="bg-foreground/10 data-horizontal:h-7 ring-1 ring-inset ring-foreground/5"
            rangeClassName="rounded-l-full"
            thumbClassName="size-8 border-foreground/10 bg-popover shadow-sm shadow-foreground/15 hover:ring-0 active:ring-0 focus-visible:ring-2 focus-visible:ring-primary/30" />
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-4 inset-y-0 flex items-center justify-between">{levels.map((level, position) => <span key={level.value} className={cn('size-1 rounded-full', position <= index ? 'bg-primary-foreground/40' : 'bg-foreground/25', position === index && 'invisible')} />)}</div>
        </div>
      </PopoverContent>
  </Popover>;
}
