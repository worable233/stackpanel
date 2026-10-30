'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  CaptchaClientConfig,
  CaptchaContainerWidgetConfig,
  CaptchaElementWidgetConfig,
  CaptchaScriptWidgetConfig,
} from '@stackpanel/sdk';
import { useTranslator } from '@/i18n/provider';

/**
 * Vendor-agnostic human-verification widget.
 *
 * The host implements the three protocols a provider can publish (see the SDK's
 * `CaptchaClientConfig`) and knows no vendor at all: swapping Turnstile for Cap
 * for a private siteverify endpoint changes configuration, never this file.
 *
 * Rendering rules:
 *  - `config === null` renders nothing. That is the "no provider installed"
 *    case, and it must leave the surrounding form byte-for-byte as it was —
 *    human verification is an optional plugin, so its absence cannot change a
 *    login page.
 *  - A widget that fails to load shows an explicit, retryable message instead of
 *    disappearing. Under a `required` policy a silent failure strands the user
 *    on a form they can never submit with no explanation.
 *
 * The token is reported upward through `onToken` on every change (including
 * expiry/withdrawal, reported as `null`) so the surrounding form owns a single
 * hidden input rather than each widget reaching into the DOM.
 */

/** Loaded script registry: one <script> per URL, shared by every widget instance. */
const scriptLoads = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const existing = scriptLoads.get(src);
  if (existing) return existing;
  const pending = new Promise<void>((resolve, reject) => {
    const element = document.createElement('script');
    element.src = src;
    element.async = true;
    element.defer = true;
    element.addEventListener('load', () => resolve());
    element.addEventListener('error', () => {
      // Drop the cache entry so a retry can re-attempt the request instead of
      // resolving against a permanently rejected promise.
      scriptLoads.delete(src);
      reject(new Error(`captcha widget script failed: ${src}`));
    });
    document.head.appendChild(element);
  });
  scriptLoads.set(src, pending);
  return pending;
}

interface RenderHandle {
  remove?: (element: HTMLElement) => void;
}

interface WidgetFactory {
  render: (element: HTMLElement, options: Record<string, unknown>) => RenderHandle | string | undefined;
  /**
   * Tear down a widget. Vendors disagree on the argument: some take the id the
   * `render` call returned, some take the container element. Both are covered by
   * one loose signature rather than a per-vendor adapter.
   */
  remove?: (target: string | HTMLElement) => void;
}

function scriptWidget(
  config: CaptchaScriptWidgetConfig,
  container: HTMLElement,
  onToken: (token: string | null) => void,
  onError: () => void,
): () => void {
  let cancelled = false;
  let widgetId: string | undefined;
  let factory: WidgetFactory | undefined;

  void loadScript(config.script)
    .then(() => {
      if (cancelled) return;
      factory = (window as unknown as Record<string, WidgetFactory | undefined>)[config.globalFn];
      if (!factory?.render) {
        onError();
        return;
      }
      const handle = factory.render(container, {
        sitekey: config.siteKey,
        ...(config.action ? { action: config.action } : {}),
        ...(config.theme ? { theme: config.theme } : {}),
        ...(config.locale ? { language: config.locale } : {}),
        // The vendor's success callback. `reset` semantics differ per vendor, so
        // an expired token is simply reported as "no token".
        callback: (token: string) => onToken(token),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
        ...config.renderOptions,
      });
      if (typeof handle === 'string') widgetId = handle;
    })
    .catch(() => {
      if (!cancelled) onError();
    });

  return () => {
    cancelled = true;
    onToken(null);
    // Vendors that return an id expose `remove(id)` on the factory; those that
    // return a handle expose `remove(element)`.
    if (widgetId && factory?.remove) factory.remove(widgetId);
    else if (factory?.remove) factory.remove(container);
  };
}

function elementWidget(
  config: CaptchaElementWidgetConfig,
  container: HTMLElement,
  onToken: (token: string | null) => void,
): () => void {
  const element = document.createElement(config.tag);
  for (const [name, value] of Object.entries(config.attributes)) {
    element.setAttribute(name, value);
  }
  const read = (): void => {
    // The protocol names the attribute the widget writes its solution into; the
    // host never learns what the value means.
    const value = element.getAttribute(config.tokenAttribute);
    onToken(value && value.trim().length > 0 ? value : null);
  };
  element.addEventListener(config.event, read);
  if (config.resetEvent) element.addEventListener(config.resetEvent, () => onToken(null));
  container.appendChild(element);
  return () => {
    onToken(null);
    element.remove();
  };
}

/** Resolve a dotted global path (`capCaptcha.mount`) and call it, if it is a function. */
function callGlobal(path: string | undefined): void {
  if (!path) return;
  let target: unknown = window;
  for (const part of path.split('.')) {
    if (!target || typeof target !== 'object') return;
    target = (target as Record<string, unknown>)[part];
  }
  if (typeof target === 'function') (target as () => void)();
}

/** How often the injected hidden field is polled for a new solution. */
const TOKEN_POLL_MS = 400;
/** How long a mounted container may stay empty before it is called broken. */
const MOUNT_GRACE_MS = 8_000;

/**
 * `container` protocol: the vendor's loader owns the DOM inside the container and
 * reports the solution through a hidden form field it injects itself.
 *
 * The host therefore never touches the widget — it only (a) places a container
 * the loader recognises, (b) asks the loader to re-scan, because a script that
 * scans on `DOMContentLoaded` cannot see a container React inserted afterwards,
 * and (c) watches the hidden input the contract names.
 *
 * Polling, not events: the value is assigned through the property (`input.value =
 * …`), which fires no mutation record, and the field may be re-created on reset.
 * A 400 ms read of one input is cheaper than being wrong about which of those the
 * vendor does.
 */
function containerWidget(
  config: CaptchaContainerWidgetConfig,
  container: HTMLElement,
  onToken: (token: string | null) => void,
  onError: () => void,
): () => void {
  let cancelled = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let last: string | null = null;

  void loadScript(config.script)
    .then(() => {
      if (cancelled) return;
      const box = document.createElement('div');
      box.className = config.containerClass;
      box.setAttribute('data-sitekey', config.siteKey);
      for (const [name, value] of Object.entries(config.attributes ?? {})) {
        box.setAttribute(name, value);
      }
      container.appendChild(box);
      // Without the re-scan the container stays invisible to a loader that already
      // ran on page load — the widget silently never appears.
      callGlobal(config.remount);

      // The injected input belongs to the surrounding <form>, so read from there;
      // falling back to the container keeps a detached preview working.
      const scope: ParentNode = container.closest('form') ?? container;
      const read = (): void => {
        const field = scope.querySelector<HTMLInputElement>(
          `input[name="${CSS.escape(config.hiddenField)}"]`,
        );
        const value = field?.value?.trim() ?? '';
        const next = value.length > 0 ? value : null;
        if (next === last) return;
        last = next;
        onToken(next);
      };
      poll = setInterval(read, TOKEN_POLL_MS);

      // A loader that refused the request (blocked origin, bad site key, CORS on
      // its own module script) renders nothing usable and reports nothing. Turning
      // silence into a visible error is the difference between "retry" and a form
      // nobody can submit.
      //
      // "Rendered" means the loader actually created its token field. A broken
      // loader still inserts an element (a custom tag that never upgrades when its
      // own module script fails CORS), so counting child elements hides exactly the
      // failure worth surfacing. The protocol guarantees the field once mounted.
      grace = setTimeout(() => {
        if (cancelled) return;
        const field = scope.querySelector(`input[name="${CSS.escape(config.hiddenField)}"]`);
        if (!field) onError();
      }, MOUNT_GRACE_MS);
    })
    .catch(() => {
      if (!cancelled) onError();
    });

  return () => {
    cancelled = true;
    if (poll) clearInterval(poll);
    if (grace) clearTimeout(grace);
    onToken(null);
    // The hidden field the loader injected is the vendor's, not ours; React owns
    // the form, so it is removed with the container subtree on unmount.
  };
}

export function CaptchaField({
  config,
  onToken,
  className,
}: {
  /** Widget config for the guarded action, or `null` when nothing guards it. */
  config: CaptchaClientConfig | null | undefined;
  /** Called with the token, or `null` when the widget has not solved / expired. */
  onToken: (token: string | null) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const t = useTranslator();

  // `onToken` is identity-unstable in most forms (inline arrow); keep it in a ref
  // so it cannot tear down and re-render a solved widget on every parent render.
  const reportRef = useRef(onToken);
  reportRef.current = onToken;

  const kind = config?.kind;
  const scriptSrc = config && config.kind === 'script' ? config.script : null;

  useEffect(() => {
    if (!config) return;
    const container = containerRef.current;
    if (!container) return;
    setFailed(false);
    container.replaceChildren();
    const report = (token: string | null): void => reportRef.current(token);
    const cleanup =
      config.kind === 'script'
        ? scriptWidget(config, container, report, () => setFailed(true))
        : config.kind === 'element'
          ? elementWidget(config, container, report)
          : containerWidget(config, container, report, () => setFailed(true));
    return () => {
      cleanup();
      container.replaceChildren();
    };
    // `config` is a server-rendered literal; comparing by kind + script is enough
    // to avoid re-mounting on every parent render.
  }, [config, kind, scriptSrc, attempt]);

  if (!config) return null;

  return (
    <div className={className}>
      <div ref={containerRef} />
      {failed ? (
        <div className="space-y-1 text-sm text-destructive">
          <p>{t('auth.captcha.unavailable')}</p>
          <button
            type="button"
            className="text-xs underline underline-offset-2"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t('auth.captcha.retry')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
