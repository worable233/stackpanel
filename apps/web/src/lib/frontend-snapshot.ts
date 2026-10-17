import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import type { FrontendCandidate } from './slots';

/**
 * Contract 04 §3 — one deployment version per request.
 *
 * A single page render can touch several frontends (the active theme plus every
 * plugin that contributes pages/finders/widgets) and, on top of that, emit asset
 * URLs for each. If each call re-resolved the active revision independently, an
 * install landing mid-request could mix two revisions in one render: some chunks
 * from the old immutable directory, some from the new one.
 *
 * The snapshot pins the resolution **once** for the lifetime of a request. It is
 * stored in `AsyncLocalStorage` so:
 *   - every helper called down the render tree (finders, layouts, settings, SEO)
 *     sees the same candidates; and
 *   - concurrent requests stay isolated from each other.
 *
 * Resolution is lazy (a promise per surface), so a request that only needs the
 * theme never pays for the plugin list, while still sharing it if something else
 * later asks for it.
 */
export interface FrontendSnapshot {
  theme?: Promise<FrontendCandidate | null>;
  plugins?: Promise<FrontendCandidate[]>;
}

const storage = new AsyncLocalStorage<FrontendSnapshot>();

/**
 * The snapshot for the current request, creating one if none is active.
 *
 * `enterWith` (rather than `run`) is used deliberately: the route shell is not
 * the only entry point (metadata generation, server actions and prefetching all
 * call these helpers), so the snapshot must attach to whatever async context is
 * currently executing instead of requiring every caller to wrap its whole render.
 */
export function frontendSnapshot(): FrontendSnapshot {
  const existing = storage.getStore();
  if (existing) return existing;
  const created: FrontendSnapshot = {};
  storage.enterWith(created);
  return created;
}

/** Memoize a resolver on `key` within the current request snapshot. */
export function pinInSnapshot<R>(key: keyof FrontendSnapshot, resolve: () => Promise<R>): Promise<R> {
  const store = frontendSnapshot() as Record<string, Promise<unknown> | undefined>;
  const existing = store[key] as Promise<R> | undefined;
  if (existing) return existing;
  const pending = resolve();
  store[key] = pending;
  // A transient failure must not poison the rest of the request.
  pending.catch(() => {
    if (store[key] === pending) delete store[key];
  });
  return pending;
}

/** Run `fn` with a fresh snapshot (used by server actions / tests). */
export function runWithFrontendSnapshot<T>(fn: () => T): T {
  return storage.run({}, fn);
}

/** Drop the active snapshot (test helper). */
export function resetFrontendSnapshot(): void {
  storage.enterWith({});
}
