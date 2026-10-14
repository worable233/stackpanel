'use client';

import { useEffect, useRef } from 'react';

/** Document scrolling stays native; this overlay replaces only its desktop chrome. */
export function DocumentScrollbar() {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; scroll: number } | null>(null);
  const geometry = useRef({ travel: 1, max: 1 });
  useEffect(() => {
    const element = thumb.current;
    if (!element) return;
    const animation = element.animate([{ height: '40px', transform: 'translateY(0)' }], {
      duration: 1,
      fill: 'both',
    });
    animation.pause();
    animation.currentTime = 0;
    const update = () => {
      const height = track.current?.clientHeight ?? innerHeight;
      const total = document.documentElement.scrollHeight;
      const size = Math.min(height, Math.max(40, (height * innerHeight) / total));
      const max = Math.max(1, total - innerHeight);
      const travel = Math.max(1, height - size);
      geometry.current = { travel, max };
      const frame = {
        height: `${size}px`,
        transform: `translateY(${Math.min(travel, Math.max(0, (scrollY / max) * travel))}px)`,
      };
      (animation.effect as KeyframeEffect).setKeyframes([frame, frame]);
      element.setAttribute('aria-valuenow', String(Math.round(Math.max(0, (scrollY / max) * 100))));
      if (track.current) track.current.hidden = total <= innerHeight;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(document.body);
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      animation.cancel();
      observer.disconnect();
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return (
    <div
      ref={track}
      aria-label="页面滚动轨道"
      className="group/scroll fixed inset-y-1 right-0 z-[60] w-3 touch-none bg-[var(--clarity-background)] [@media(pointer:coarse)]:hidden"
      onPointerDown={(event) => {
        if (event.target === thumb.current) return;
        const rect = event.currentTarget.getBoundingClientRect();
        scrollTo({
          top: ((event.clientY - rect.top) / rect.height) * geometry.current.max,
          behavior: 'instant',
        });
      }}
    >
      <div
        ref={thumb}
        role="scrollbar"
        tabIndex={0}
        aria-label="页面滚动"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
        aria-controls="clarity-page-content"
        className="absolute left-[3px] right-[3px] min-h-10 cursor-grab rounded-full bg-[var(--clarity-scroll-thumb)] transition-colors hover:bg-[var(--clarity-scroll-thumb-hover)] focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing"
        onPointerDown={(event) => {
          event.stopPropagation();
          drag.current = { y: event.clientY, scroll: scrollY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current)
            scrollTo({
              top:
                drag.current.scroll +
                ((event.clientY - drag.current.y) / geometry.current.travel) * geometry.current.max,
              behavior: 'instant',
            });
        }}
        onPointerUp={(event) => {
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          const positions: Record<string, number> = {
            ArrowDown: scrollY + 40,
            ArrowUp: scrollY - 40,
            PageDown: scrollY + innerHeight,
            PageUp: scrollY - innerHeight,
            Home: 0,
            End: geometry.current.max,
          };
          const position = positions[event.key];
          if (position !== undefined) {
            event.preventDefault();
            scrollTo({ top: position, behavior: 'instant' });
          }
        }}
      />
    </div>
  );
}
