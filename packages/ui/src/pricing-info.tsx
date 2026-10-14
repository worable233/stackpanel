'use client';
import { useId, useState } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';
import { Info } from 'lucide-react';
export function PricingInfo({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Tooltip.Provider delay={100}>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger
          aria-label="查看服务说明"
          aria-describedby={open ? id : undefined}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex size-6 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-current"
        >
          <Info className="size-4" />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner sideOffset={8} className="z-[70]">
            <Tooltip.Popup
              id={id}
              role="tooltip"
              className="max-w-72 origin-(--transform-origin) rounded-xl bg-[var(--clarity-foreground)] px-4 py-3 text-sm text-[var(--clarity-background)] shadow-xl transition-[opacity,transform] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
            >
              {text}
              <Tooltip.Arrow className="data-[side=top]:bottom-[-6px] data-[side=bottom]:top-[-6px] data-[side=bottom]:rotate-180">
                <svg
                  width="12"
                  height="6"
                  viewBox="0 0 12 6"
                  aria-hidden="true"
                  className="fill-[var(--clarity-foreground)]"
                >
                  <path d="M0 0h12L6 6Z" />
                </svg>
              </Tooltip.Arrow>
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
