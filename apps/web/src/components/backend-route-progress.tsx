'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

function ProgressState() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const location = `${pathname}?${searchParams.toString()}`;
  const previous = useRef(location);
  const progress = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);

  const clearTimers = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    if (finishTimer.current) clearTimeout(finishTimer.current);
    timer.current = null;
    finishTimer.current = null;
  }, []);

  const finish = useCallback(() => {
    clearTimers();
    progress.current = 100;
    setWidth(100);
    finishTimer.current = setTimeout(() => {
      setVisible(false);
      progress.current = 0;
      setWidth(0);
    }, 260);
  }, [clearTimers]);

  const start = useCallback(() => {
    clearTimers();
    progress.current = Math.max(progress.current, 8);
    setWidth(progress.current);
    setVisible(true);
    timer.current = setInterval(() => {
      progress.current = Math.min(
        92,
        progress.current + Math.max(0.5, (92 - progress.current) * 0.08),
      );
      setWidth(progress.current);
    }, 180);
    finishTimer.current = setTimeout(finish, 12000);
  }, [clearTimers, finish]);

  useEffect(() => {
    if (previous.current !== location) {
      previous.current = location;
      if (progress.current > 0) finish();
    }
  }, [finish, location]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      const target = `${destination.pathname}?${destination.searchParams.toString()}`;
      if (target !== location) start();
    };
    const onPopState = () => start();
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
    };
  }, [location, start]);

  useEffect(() => clearTimers, [clearTimers]);

  return (
    <div className="clarity-route-progress" data-visible={visible} aria-hidden="true">
      <span className="clarity-route-progress__bar" style={{ width: `${width}%` }}>
        <span className="clarity-route-progress__peg" />
      </span>
    </div>
  );
}

export function BackendRouteProgress() {
  return (
    <Suspense fallback={null}>
      <ProgressState />
    </Suspense>
  );
}
