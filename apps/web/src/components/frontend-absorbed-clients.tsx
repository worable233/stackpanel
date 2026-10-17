'use client';

/**
 * Contract 02 §5 / 主计划 §5 阶段 4 — host-absorbed client capabilities.
 *
 * A runtime-loaded frontend module **cannot mint its own client reference**: under
 * the RSC server layer it is plain Node ESM, so a `'use client'` module it ships
 * would crash (`useState` is null — see SPIKE-results §0). Any *client* capability a
 * runtime package needs must therefore be **absorbed by the host** and reached
 * through the fixed ABI.
 *
 * This module is the host side of that absorption: it is bundled by Next/Turbopack,
 * so each export below is a real client-reference proxy the host renderer already
 * knows how to hydrate. `frontend-host-abi.ts` republishes these proxies so the
 * loader hook can route a runtime package's well-known client specifier to them.
 *
 * The only absorbed capability today is the default theme's `./route-progress.js`
 * (`RouteProgress`). It is behaviourally identical to the theme's own client module
 * so the theme keeps its progress bar without owning a client module it cannot
 * serialize.
 */
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
    // Next Link prevents the native navigation during bubbling; observe before it.
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
    };
  }, [location, start]);

  useEffect(() => stopTimers, [stopTimers]);

  return (
    <div className="clarity-route-progress" data-visible={visible} aria-hidden="true">
      {/* Faithful port of the default theme's `route-progress.tsx`; the theme's
          own progress bar drives width through this inline style, so the host
          copy must too (the web no-inline-style rule is for host UI, not for a
          behavioural stand-in of a theme client capability). */}
      <span className="clarity-route-progress__bar" style={{ width: `${progress}%` }}>
        <span className="clarity-route-progress__peg" />
      </span>
    </div>
  );
}

/** Host-absorbed stand-in for the default theme's `./route-progress.js`. */
export function RouteProgress() {
  return (
    <Suspense fallback={null}>
      <RouteProgressState />
    </Suspense>
  );
}
