'use client';

import { Component, type ReactElement, type ReactNode } from 'react';
import { useTranslator } from '@/i18n/provider';

/**
 * Contract 06 §1.3 — render-failure degradation.
 *
 * A package page/widget that throws while rendering must not take down the host
 * shell or surface a stack trace. This boundary catches the throw, reports it
 * once to the console, and renders a neutral inline notice. The host shell,
 * navigation and every other package keep working.
 *
 * Loading failures (a module that cannot be imported) are handled earlier, by
 * `importFrontendPackage` returning null; this boundary is specifically the
 * "loaded, but rendered badly" case.
 */
export class FrontendRenderBoundary extends Component<
  { children: ReactNode; label: string },
  { failed: boolean }
> {
  state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    // i18n-exempt — developer console log, never rendered to the user.
    console.error(`[frontend] ${this.props.label} render failed`, error);
  }

  render(): ReactNode {
    if (this.state.failed) return <FrontendRenderError />;
    return this.props.children;
  }
}

/** Static, localised fallback; the raw exception stays in the console. */
function FrontendRenderError(): ReactElement {
  const t = useTranslator();
  return (
    <p role="alert" className="text-sm text-destructive">
      {t('frontend.renderFailed')}
    </p>
  );
}

/** Convenience wrapper so callers do not repeat the label. */
export function withFrontendRenderBoundary(
  label: string,
  children: ReactElement,
): ReactElement {
  return <FrontendRenderBoundary label={label}>{children}</FrontendRenderBoundary>;
}
