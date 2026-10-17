'use client';

import { Component, type ReactElement, type ReactNode } from 'react';

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
  { message: string | null }
> {
  state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: Error): { message: string } {
    return { message: error.message || 'render failed' };
  }

  componentDidCatch(error: Error): void {
    console.error(`[frontend] ${this.props.label} 渲染失败`, error);
  }

  render(): ReactNode {
    if (this.state.message !== null) {
      return (
        <p role="alert" className="text-sm text-destructive">
          {this.state.message}
        </p>
      );
    }
    return this.props.children;
  }
}

/** Convenience wrapper so callers do not repeat the label. */
export function withFrontendRenderBoundary(
  label: string,
  children: ReactElement,
): ReactElement {
  return <FrontendRenderBoundary label={label}>{children}</FrontendRenderBoundary>;
}
