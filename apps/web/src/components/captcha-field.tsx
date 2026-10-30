'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  CaptchaClientConfig,
  CaptchaElementWidgetConfig,
  CaptchaScriptWidgetConfig,
} from '@stackpanel/sdk';
import { useTranslator } from '@/i18n/provider';

/**
 * Vendor-agnostic human-verification widget.
 *
 * The host implements the two protocols a provider can publish (see the SDK's
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
        : elementWidget(config, container, report);
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
