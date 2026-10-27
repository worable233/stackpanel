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
import { usePathname, useSearchParams, useRouter } from 'next/navigation';

/**
 * Host-owned client behaviour for SSR plugin forms. Runtime-loaded frontend
 * packages cannot create a client reference themselves, so this component
 * observes a native form and submits it after a configuration change.
 */
export function AutoSubmitForm({ formId, delay = 250 }: { formId: string; delay?: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const status = document.querySelector<HTMLElement>(`[data-quote-status="${formId}"]`);
    const initial = new URLSearchParams(
      new FormData(form) as unknown as URLSearchParams,
    ).toString();
    const setPending = (pending: boolean) => {
      form.setAttribute('aria-busy', String(pending));
      document
        .querySelectorAll<HTMLButtonElement>(`button[data-quote-purchase="${formId}"]`)
        .forEach((button) => {
          button.disabled = pending || button.dataset.unavailable === 'true';
        });
      if (status) status.hidden = !pending;
    };
    setPending(false);
    const navigate = () => {
      if (!form.reportValidity()) return;
      const url = new URL(form.action, window.location.href);
      url.search = new URLSearchParams(new FormData(form) as unknown as URLSearchParams).toString();
      if (url.origin === window.location.origin) router.replace(url.pathname + url.search, { scroll: false });
    };
    const onSubmit = (event: SubmitEvent) => {
      const submitter = event.submitter;
      if (
        (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) &&
        submitter.hasAttribute('formaction')
      ) {
        if (timer) clearTimeout(timer);
        const changed =
          new URLSearchParams(new FormData(form) as unknown as URLSearchParams).toString() !== initial;
        if (!changed && form.getAttribute('aria-busy') !== 'true') return;
      }
      event.preventDefault();
      if (!form.reportValidity()) {
        setPending(false);
        return;
      }
      setPending(true);
      navigate();
    };
    const submit = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      if (target.form !== form || target.disabled) return;
      if (
        new URLSearchParams(new FormData(form) as unknown as URLSearchParams).toString() === initial
      ) {
        if (timer) clearTimeout(timer);
        setPending(false);
        return;
      }
      setPending(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        navigate();
      }, delay);
    };
    document.addEventListener('input', submit);
    document.addEventListener('change', submit);
    form.addEventListener('submit', onSubmit);
    const restore = () => {
      const changed =
        new URLSearchParams(new FormData(form) as unknown as URLSearchParams).toString() !==
        initial;
      setPending(changed);
      if (changed) navigate();
    };
    window.addEventListener('pageshow', restore);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('input', submit);
      document.removeEventListener('change', submit);
      form.removeEventListener('submit', onSubmit);
      window.removeEventListener('pageshow', restore);
    };
  }, [delay, formId, router, searchParams]);
  return null;
}

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

/**
 * Host-absorbed stand-in for the referral plugin's `./route-progress.js`.
 *
 * The plugin ships a client module with the same *filename* as the default
 * theme's but a different export (`CopyLinkButton`). Because runtime packages
 * are plain Node ESM on the server, the plugin's own `'use client'` module cannot
 * be imported there — so the host must provide the client behaviour, exactly as
 * it does for the theme. Kept behaviourally identical to the plugin's original:
 * copy `origin/?affid=<code>` to the clipboard, with a `execCommand` fallback and
 * a short "copied" acknowledgement.
 */
export function CopyLinkButton({
  code,
  copyLabel,
  copiedLabel,
}: {
  code: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    const link = `${window.location.origin}/?affid=${encodeURIComponent(code)}`;
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    const fallback = () => {
      try {
        const area = document.createElement('textarea');
        area.value = link;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        done();
      } catch {
        /* clipboard unavailable — leave the label unchanged */
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(link).then(done).catch(fallback);
      return;
    }
    fallback();
  }, [code]);
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted"
    >
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}
