'use client';

import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

/**
 * Contract 05 §3.5 / contract 01 §7 — Portal scope propagation.
 *
 * A package's `styles[]` are scoped to `[data-sp-frontend="<kind>:<id>"]`. Base UI
 * primitives (Dialog, Select, DropdownMenu, Tooltip) render their popups through a
 * portal that defaults to `<body>`, which would escape that scope marker, so the
 * package's own styling would not apply to overlays.
 *
 * This context carries the owning package's scope down to those primitives. When a
 * portal is opened inside a scoped subtree, it mounts into a dedicated container
 * that itself carries the marker, so overlay content stays inside the package's
 * style scope without leaking to the host.
 */

const FrontendScopeContext = createContext<string | null>(null);

export function FrontendScopeProvider({
  scope,
  children,
}: {
  /** `"<kind>:<id>"`, matching the `data-sp-frontend` marker. */
  scope: string;
  children: ReactNode;
}): ReactNode {
  return <FrontendScopeContext.Provider value={scope}>{children}</FrontendScopeContext.Provider>;
}

/** The owning package's scope marker, or null when rendering host-owned UI. */
export function useFrontendScope(): string | null {
  return useContext(FrontendScopeContext);
}

/** Client-only gate: `false` during SSR, `true` after hydration. */
const subscribeNoop = () => () => undefined;
function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

/**
 * Create (or reuse) the scope-marked portal container element appended to
 * `<body>`. Pure lookup during render — no state updates in an effect — so a
 * portal opened after mount resolves its container on the first render.
 */
function portalContainer(scope: string): HTMLElement {
  const id = `sp-portal-${scope.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const existing = document.getElementById(id);
  if (existing) return existing;
  const element = document.createElement('div');
  element.id = id;
  element.setAttribute('data-sp-frontend', scope);
  document.body.appendChild(element);
  return element;
}

/**
 * An element carrying the current package's scope marker, for use as a portal
 * `container`. Returns `undefined` outside a scoped subtree (or during SSR), so
 * the primitive keeps its default `<body>` portal.
 *
 * The container is intentionally never removed: it is shared by every portal of
 * the same package, and tearing it down could unmount a sibling portal mid-close.
 */
export function useFrontendPortalContainer(): HTMLElement | undefined {
  const scope = useFrontendScope();
  const isClient = useIsClient();
  return useMemo(() => {
    if (!scope || !isClient || typeof document === 'undefined') return undefined;
    return portalContainer(scope);
  }, [scope, isClient]);
}

/** Stable `data-sp-frontend` wrapper for a package's render root (contract 05 §3.3). */
export function FrontendScopeRoot({
  scope,
  children,
  className = 'contents',
}: {
  scope: string;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <FrontendScopeProvider scope={scope}>
      <div className={className} data-sp-frontend={scope}>
        {children}
      </div>
    </FrontendScopeProvider>
  );
}
