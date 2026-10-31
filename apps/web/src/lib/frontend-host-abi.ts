import 'server-only';

/**
 * Contract 02 §5 / 主计划 §5 阶段 4 — the host RSC ABI publisher (M1 server side).
 *
 * A frontend package loaded at runtime is plain Node ESM from `data/`. In the RSC
 * server graph, `@stackpanel/ui`'s `'use client'` components are **client-reference
 * proxies** that only the host bundled, and `next/*` resolves to the host's own
 * adapters. Importing those bare specifiers from an un-bundled runtime module would
 * resolve to raw `node_modules` files and crash in RSC (`useState` is null —
 * SPIKE-results §0).
 *
 * This module is imported (and thus executed) **inside the host's RSC graph**, so
 * each import below is the host's real instance. It republishes them on
 * `globalThis.__STACKPANEL_SERVER_ABI__`, which the synchronous Node resolve hook in
 * `scripts/frontend-loader.mjs` reads to redirect a runtime module's host-ABI
 * specifiers to these exact host namespaces.
 *
 * Importing this module has a side effect (publishing the ABI), so the runtime
 * loader imports it before the first runtime `import()`.
 */
import * as ui from '@stackpanel/ui';
import * as link from 'next/link';
import * as form from 'next/form';
import * as navigation from 'next/navigation';
import * as jsxRuntime from 'react/jsx-runtime';
import * as react from 'react';
import * as sdk from '@stackpanel/sdk';
import * as lucide from 'lucide-react';
import * as sonner from 'sonner';
// NOTE: do **not** import `recharts` here. This module is evaluated inside the
// RSC server graph, and Recharts calls `React.createContext` at module scope —
// the server React build has no `createContext`, so the import throws
// "createContext only works in Client Components" and every page 500s.
// If a plugin ever needs charts, publish them from a `'use client'` module the
// way `frontend-abi-bridge.tsx` publishes the rest of the client ABI.
import { AutoSubmitForm, CopyLinkButton, RouteProgress } from '@/components/frontend-absorbed-clients';
import { CartCheckout } from '@/components/cart-checkout';
import { navigationServerAbi } from './frontend-loader';

/**
 * Host-absorbed client capabilities, keyed by the **dist file stem** of the client
 * module a runtime package ships (contract 02 §5; SPIKE-results §0). A runtime
 * package cannot serialize its own `'use client'` module, so the loader hook maps
 * a relative import of `./<stem>.js` inside a package's `dist/` to the host-bundled
 * stand-in.
 *
 * Today only the default theme's `route-progress.js` (stem `route-progress`) needs
 * absorption; new capabilities are added here.
 */
const ABSORBED_CLIENT_CAPABILITIES: Record<string, unknown> = {
  // Keyed by dist file stem, shared by every package that ships a module with
  // that name. The shim re-exports every name here, so each package only picks
  // up the exports it actually imports.
  // - default theme's `route-progress.js` → RouteProgress
  // - referral plugin's `route-progress.js` → CopyLinkButton
  'route-progress': { RouteProgress, CopyLinkButton },
  'auto-submit': { AutoSubmitForm, CartCheckout },
};

export type HostServerAbi = Record<string, unknown>;

/**
 * Publish the host RSC ABI on `globalThis` and return it. Must run before any
 * runtime `import()` of a frontend package so the resolve hook can see it.
 *
 * Assigned on every call rather than once: the value is a cheap object over
 * module-level imports, and a stale snapshot is a trap — a long-running dev server
 * kept publishing the ABI captured at boot, so a fix to what a slot exports (see
 * `navigationServerAbi`) never took effect until the process restarted. The shim
 * reads the global lazily, so swapping the object is safe.
 */
export function publishHostServerAbi(): HostServerAbi {
  const g = globalThis as unknown as {
    __STACKPANEL_SERVER_ABI__?: HostServerAbi;
    __STACKPANEL_ABSORBED_CLIENT__?: Record<string, unknown>;
  };
  g.__STACKPANEL_SERVER_ABI__ = {
    react,
    'react/jsx-runtime': jsxRuntime,
    'next/link': link,
    'next/form': form,
    'next/navigation': navigationServerAbi(navigation as unknown as Record<string, unknown>),
    '@stackpanel/ui': ui,
    '@stackpanel/sdk': sdk,
    'lucide-react': lucide,
    sonner,
  };
  // Client references are refreshed too, so development hot reload picks up new
  // absorbed capabilities.
  g.__STACKPANEL_ABSORBED_CLIENT__ = ABSORBED_CLIENT_CAPABILITIES;
  return g.__STACKPANEL_SERVER_ABI__;
}

/** Dist file stem → host-absorbed capability (for tests / the loader hook). */
export const ABSORBED_CLIENT_STEMS = Object.keys(ABSORBED_CLIENT_CAPABILITIES);
