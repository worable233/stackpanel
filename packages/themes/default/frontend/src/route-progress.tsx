'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

function RouteProgressState() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const location = `${pathname}?${searchParams.toString()}`;
  const previousLocation = useRef(location);
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const progressRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTimers = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (finishRef.current) clearTimeout(finishRef.current);
    tickRef.current = null;
    finishRef.current = null;
  }, []);

  const finish = useCallback(() => {
    stopTimers();
    progressRef.current = 100;
    setProgress(100);
    finishRef.current = setTimeout(() => {
      setVisible(false);
      progressRef.current = 0;
      setProgress(0);
    }, 260);
  }, [stopTimers]);

  const start = useCallback(() => {
    stopTimers();
    progressRef.current = Math.max(progressRef.current, 8);
    setProgress(progressRef.current);
    setVisible(true);
    tickRef.current = setInterval(() => {
      const remaining = 92 - progressRef.current;
      progressRef.current = Math.min(92, progressRef.current + Math.max(0.5, remaining * 0.08));
      setProgress(progressRef.current);
    }, 180);
    finishRef.current = setTimeout(finish, 12000);
  }, [finish, stopTimers]);

  useEffect(() => {
    if (previousLocation.current !== location) {
      previousLocation.current = location;
      if (progressRef.current > 0) finish();
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
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (`${destination.pathname}?${destination.searchParams.toString()}` === location) return;
      start();
    };
    const onPopState = () => start();
    document.addEventListener('click', onClick);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('popstate', onPopState);
      stopTimers();
    };
  }, [location, start, stopTimers]);

  return (
    <div
      className="clarity-route-progress"
      data-visible={visible}
      aria-hidden="true"
    >
      <span className="clarity-route-progress__bar" style={{ width: `${progress}%` }}>
        <span className="clarity-route-progress__peg" />
      </span>
    </div>
  );
}

export function RouteProgress() {
  return (
    <Suspense fallback={null}>
      <RouteProgressState />
    </Suspense>
  );
}
