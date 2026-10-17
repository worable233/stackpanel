'use client';

import { ChevronDown, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { useTranslator } from '@/i18n/provider';
import { cn } from '@/lib/utils';

/**
 * `value` is a persisted machine contract shared with the API
 * (`reasoning: z.enum(['快速', '均衡', '深入', '极高'])`), so only the visible
 * labels are localized here.
 */
const levels = [
  { value: '快速', key: 'agent.effort.low' }, // i18n-exempt — persisted reasoning enum value
  { value: '均衡', key: 'agent.effort.medium' }, // i18n-exempt — persisted reasoning enum value
  { value: '深入', key: 'agent.effort.high' }, // i18n-exempt — persisted reasoning enum value
  { value: '极高', key: 'agent.effort.extraHigh' }, // i18n-exempt — persisted reasoning enum value
] as const;

export function AgentEffortPicker({
  value,
  onChange,
  disabled,
  modelLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  modelLabel?: string;
}) {
  const t = useTranslator();
  const index = Math.max(
    0,
    levels.findIndex((level) => level.value === value),
  );
  const selected = levels[index] ?? levels[1];
  const resolvedModel = modelLabel ?? t('agent.effort.defaultModel');
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="gap-1.5 rounded-full px-2.5 font-normal"
            aria-label={t('agent.effort.aria')}
          />
        }
      >
        <span className="max-w-24 truncate">{resolvedModel}</span>
        <span className="text-muted-foreground">{t(selected.key)}</span>
        <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        className="w-72 max-w-[calc(100vw-1.5rem)] gap-0 rounded-[20px] border border-foreground/15 bg-popover p-3.5 shadow-xl shadow-foreground/10 ring-0 [--primary:var(--clarity-primary,var(--ring))]"
      >
        <div className="relative flex flex-col items-center gap-0.5 pb-4">
          <PopoverTitle className="text-base font-medium text-primary">
            {t(selected.key)}
          </PopoverTitle>
          <span className="max-w-[80%] truncate text-sm text-muted-foreground">
            {resolvedModel}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('agent.effort.reset')}
            onClick={() => onChange('均衡')} // i18n-exempt — persisted reasoning enum value
            className="absolute -right-0.5 -top-0.5 rounded-full text-muted-foreground"
          >
            <RotateCcw />
          </Button>
        </div>
        <div className="relative py-0.5">
          <Slider
            min={0}
            max={3}
            step={1}
            value={[index]}
            onValueChange={(next) => {
              const position = Array.isArray(next) ? next[0] : next;
              onChange((levels[position ?? 1] ?? levels[1]).value);
            }}
            thumbAlignment="edge"
            thumbProps={{ 'aria-label': t('agent.effort.slider'), 'aria-valuetext': t(selected.key) }}
            trackClassName="bg-foreground/10 data-horizontal:h-7 ring-1 ring-inset ring-foreground/5"
            rangeClassName="rounded-l-full"
            thumbClassName="size-8 border-foreground/10 bg-popover shadow-sm shadow-foreground/15 hover:ring-0 active:ring-0 focus-visible:ring-2 focus-visible:ring-primary/30"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-4 inset-y-0 flex items-center justify-between"
          >
            {levels.map((level, position) => (
              <span
                key={level.value}
                className={cn(
                  'size-1 rounded-full',
                  position <= index ? 'bg-primary-foreground/40' : 'bg-foreground/25',
                  position === index && 'invisible',
                )}
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
