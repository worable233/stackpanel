'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type {
  CaptchaClientConfig,
  CaptchaContainerWidgetConfig,
  CaptchaElementWidgetConfig,
  CaptchaScriptWidgetConfig,
} from '@stackpanel/sdk';
import { useTranslator } from '@/i18n/provider';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ALTCHA_STRINGS, resolveAltchaLocale } from '@/components/altcha-widget-strings';

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
 *
 * The one vendor-specific exception is ALTCHA localisation: its custom element
 * exposes no `strings` property, only the global `$altcha.i18n` registry. That
 * hook is isolated to `prepareAltchaAttributes` below.
 */

/** Loaded script registry: one <script> per URL, shared by every widget instance. */
const scriptLoads = new Map<string, Promise<void>>();

function prepareAltchaAttributes(attributes: Record<string, string>): Record<string, string> {
  const locale = resolveAltchaLocale(
    attributes['language'] || document.documentElement.lang || navigator.language,
  );
  const i18n = (
    window as unknown as {
      $altcha?: { i18n?: { set?: (locale: string, strings: Record<string, string>) => void } };
    }
  ).$altcha?.i18n;
  i18n?.set?.(locale, ALTCHA_STRINGS[locale]);

  let configuration: Record<string, unknown> = {};
  const raw = attributes['configuration'];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        configuration = parsed as Record<string, unknown>;
      }
    } catch {
      // A malformed vendor blob should not block verification; fall back to the
      // host's own footer suppression below.
    }
  }

  return {
    ...attributes,
    language: locale,
    configuration: JSON.stringify({ ...configuration, hideFooter: true, hideLogo: true }),
  };
}

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
  render: (
    element: HTMLElement,
    options: Record<string, unknown>,
  ) => RenderHandle | string | undefined;
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
  onError: () => void,
): () => void {
  let cancelled = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let element: HTMLElement | null = null;
  let last: string | null = null;

  const mount = (): void => {
    const node = document.createElement(config.tag);
    const attributes =
      config.tag === 'altcha-widget'
        ? prepareAltchaAttributes(config.attributes)
        : config.attributes;
    for (const [name, value] of Object.entries(attributes)) {
      node.setAttribute(name, value);
    }
    element = node;

    if (config.hiddenField) {
      // The widget drops its solution into a hidden input inside the surrounding
      // form — the same field a plain HTML post would send. Property assignment
      // fires no event, so the field is polled, exactly as in `containerWidget`.
      const name = config.hiddenField;
      const scope: ParentNode = container.closest('form') ?? container;
      const selector = `input[name="${CSS.escape(name)}"]`;
      const read = (): void => {
        const value = scope.querySelector<HTMLInputElement>(selector)?.value?.trim() ?? '';
        const next = value.length > 0 ? value : null;
        if (next === last) return;
        last = next;
        onToken(next);
      };
      container.appendChild(node);
      poll = setInterval(read, TOKEN_POLL_MS);
      // Silence is the only symptom of a script that failed to load or of an
      // element that never upgraded; a form nobody can submit must say so.
      grace = setTimeout(() => {
        if (!cancelled && !scope.querySelector(selector)) onError();
      }, MOUNT_GRACE_MS);
      return;
    }

    const attribute = config.tokenAttribute;
    const read = (event?: Event): void => {
      // Two published shapes: the solution arrives either in the event's `detail`
      // (`statechange` → `{ payload }`) or in the attribute the provider named.
      // The host knows neither the vendor nor what the value means.
      const detail = (event as CustomEvent<{ payload?: unknown }> | undefined)?.detail;
      const fromEvent = typeof detail?.payload === 'string' ? detail.payload.trim() : '';
      const value = attribute ? node.getAttribute(attribute) : null;
      const token = fromEvent || (value ? value.trim() : '');
      onToken(token.length > 0 ? token : null);
    };
    node.addEventListener(config.event, read);
    if (config.resetEvent) node.addEventListener(config.resetEvent, () => onToken(null));
    container.appendChild(node);
  };

  if (config.script) {
    // A custom element renders nothing until its defining script has run, so the
    // element is created only after the load settles (or the failure is shown).
    void loadScript(config.script)
      .then(() => {
        if (!cancelled) mount();
      })
      .catch(() => {
        if (!cancelled) onError();
      });
  } else {
    mount();
  }

  return () => {
    cancelled = true;
    if (poll) clearInterval(poll);
    if (grace) clearTimeout(grace);
    onToken(null);
    element?.remove();
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
          ? elementWidget(config, container, report, () => setFailed(true))
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
    <div
      className={cn(
        'relative flex min-h-16 flex-col justify-center rounded-2xl bg-muted/35 px-4 py-3',
        // The vendor widget is light DOM; these custom properties are its
        // supported styling surface. Only paint the host — never reach into
        // `.altcha-*` internals, which are not part of the widget contract.
        '[&_altcha-widget]:block [&_altcha-widget]:w-full',
        '[&_altcha-widget]:[--altcha-max-width:100%]',
        '[&_altcha-widget]:[--altcha-border-width:0px]',
        '[&_altcha-widget]:[--altcha-border-color:transparent]',
        '[&_altcha-widget]:[--altcha-border-radius:0px]',
        '[&_altcha-widget]:[--altcha-color-base:transparent]',
        '[&_altcha-widget]:[--altcha-color-base-content:var(--foreground)]',
        '[&_altcha-widget]:[--altcha-color-primary:var(--foreground)]',
        '[&_altcha-widget]:[--altcha-color-primary-content:var(--background)]',
        '[&_altcha-widget]:[--altcha-color-success:var(--foreground)]',
        '[&_altcha-widget]:[--altcha-color-success-content:var(--background)]',
        '[&_altcha-widget]:[--altcha-color-neutral:var(--muted-foreground)]',
        '[&_altcha-widget]:[--altcha-color-neutral-content:var(--foreground)]',
        '[&_altcha-widget]:[--altcha-padding:0px]',
        '[&_altcha-widget]:[--altcha-shadow:none]',
        className,
      )}
    >
      <div ref={containerRef} />
      {failed ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl bg-destructive/8 px-4 py-3 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{t('auth.captcha.unavailable')}</span>
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 self-start text-destructive hover:bg-destructive/10 hover:text-destructive sm:self-auto"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t('auth.captcha.retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
