/**
 * Kernel capability services the isolated worker exposes on `PluginContext`.
 *
 * The SDK is the frozen contract (ADR-0021 §D3 / INTERFACES §3.1): some service
 * methods are declared **synchronous** — `secrets.isAvailable()` returns a
 * `boolean`, `captcha.mode()` returns a mode, `payments.listPaymentMethods()`
 * returns a listing. Every RPC hop is asynchronous, so proxying those through
 * `callHost` handed plugins a `Promise` where the type said otherwise. A Promise
 * is truthy, which turned `if (!ctx.secrets.isAvailable())` into dead code: the
 * guard always took the "secrets are configured" branch. Builtin plugins never
 * saw this because they run in-process and never cross the bridge.
 *
 * The fix ships the **facts** those methods answer from, and lets the worker
 * derive the answer locally. Two shapes are needed:
 *
 * - {@link SYNC_SERVICE_METHODS} — value methods. Ship the value, return it.
 * - {@link SYNC_SERVICE_PREDICATES} — methods that take an argument and can only
 *   be a function (`notificationPolicy.declares(type)`). Ship the catalog behind
 *   them; the worker rebuilds the same pure predicate. Shipping a value here is
 *   impossible by construction, which is why they cannot share one table.
 *
 * Two properties keep this honest:
 * - A snapshot grants **no new authority**. `ISOLATED_CONTEXT_SERVICES` is the
 *   same list the worker's `ctx.*` accessors could always reach, so snapshotting
 *   it cannot widen a plugin's scope (scope stays declared by `inject`, which
 *   only governs `ctx.getService`).
 * - A snapshot is **refreshed whenever a plugin activates or deactivates**, and
 *   when runtime config is saved — exactly when the registries behind these
 *   values change. Anything needing per-request freshness must stay async in the
 *   SDK rather than pretending to be a snapshot.
 */

/** Bare kernel service names reachable as `ctx.<name>` inside a worker. */
export const ISOLATED_CONTEXT_SERVICES = [
  'state',
  'auth',
  'notifications',
  'notificationPolicy',
  'identity',
  'captcha',
  'secrets',
  'payments',
  'wallet',
  'fx',
  'currency',
  'cache',
] as const;

export type IsolatedContextService = (typeof ISOLATED_CONTEXT_SERVICES)[number];

/**
 * Methods whose whole answer is one value. The host calls them once per snapshot
 * and ships the result.
 */
export const SYNC_SERVICE_METHODS: Readonly<
  Partial<Record<IsolatedContextService, readonly string[]>>
> = Object.freeze({
  auth: ['sessionCookieConfig'],
  secrets: ['isAvailable'],
  captcha: ['mode', 'isConfigured', 'providerIds'],
  identity: ['requiresEmailVerification', 'isDeliveryConfigured', 'senderIds'],
  payments: ['listPaymentMethods', 'providerModes'],
});

/**
 * Methods declared synchronous that take arguments, so they cannot be reduced to
 * a shipped value. Each entry names the catalog the host must ship; the worker
 * rebuilds the predicate from it (see `predicateFor` in `worker.ts`).
 */
export const SYNC_SERVICE_PREDICATES: Readonly<
  Partial<Record<IsolatedContextService, readonly string[]>>
> = Object.freeze({
  notificationPolicy: ['declares'],
});

/**
 * Provider-shaped capabilities (handed out as a handle, not a kernel service)
 * whose methods the SDK declares **synchronous** but which the bridge cannot
 * serve synchronously.
 *
 * `StorageProvider.url(key)` is the case: it returns a `string`, but the worker
 * reaches it through `storage.invoke`, which awaits every method uniformly — so
 * an isolated plugin gets a `Promise<string>` where the SDK promised a `string`.
 * Concatenating that into markup yields `[object Promise]`, silently.
 *
 * It cannot be fixed the way the kernel services above are fixed. Those are
 * snapshotted because their answer is a *value*; `url(key)` is a *function* of
 * an argument the host does not know ahead of time, and the URL itself is
 * provider-specific (local path vs S3 base vs image host), so the worker cannot
 * compute it either without duplicating every provider's rules.
 *
 * The honest fix is therefore a signature change — `url` becomes async, or the
 * plugin-facing backend drops it in favour of the already-async `signedUrl()`.
 * Both touch `packages/sdk/src/storage.ts` and the kernel's own sync
 * `provider-router.url()`, so it is tracked separately instead of being papered
 * over here. Documented because "returns a promise where a string is expected"
 * is exactly the silent breakage this module exists to eliminate, and the next
 * reader should not assume it is covered.
 *
 * Pinned by `isolated-service-contract.test.ts` so the gap stays visible.
 */
export const KNOWN_ASYNC_ONLY_METHODS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  storage: ['url'],
});

/** Catalog of declared notification types, the input to `declares()`. */
export interface NotificationTypeCatalog {
  /** Exact types and `.*` wildcards, as registered by the kernel and plugins. */
  types: readonly string[];
}

/**
 * Whether a value survives the IPC channel intact.
 *
 * This mirrors `encodeWire` + `JSON.stringify` — what the frame actually goes
 * through — rather than `structuredClone`, which would accept a class instance
 * or a cycle that the real wire path mangles. Accepting those silently is the
 * same failure mode this module exists to remove, so the check is deliberately
 * strict about anything a snapshot should never contain.
 */
export function isWireSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'undefined':
      return true;
    // `encodeWire` has explicit branches for these three, so they survive.
    case 'bigint':
      return false;
    default:
      break;
  }
  if (typeof value !== 'object') return false;
  if (value instanceof Date) return true;
  if (value instanceof Error) return true;
  if (value instanceof Uint8Array) return true;
  const object = value as object;
  if (seen.has(object)) return false; // the wire encoder throws on cycles
  seen.add(object);
  try {
    if (Array.isArray(object)) return object.every((item) => isWireSafe(item, seen));
    // Only plain objects survive as themselves; an instance would arrive as `{}`
    // with its prototype (and therefore its identity) silently dropped.
    const proto = Object.getPrototypeOf(object) as object | null;
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(object as Record<string, unknown>).every((item) => isWireSafe(item, seen));
  } finally {
    seen.delete(object);
  }
}

/** `{ service: { method: value } }` for every value method answerable now. */
export type SyncServiceSnapshot = Record<string, Record<string, unknown>>;

/** `{ service: { method: shipped input } }` for every predicate method. */
export type SyncServicePredicateInput = Record<string, Record<string, unknown>>;

export interface TakenSyncContract {
  values: SyncServiceSnapshot;
  predicates: SyncServicePredicateInput;
}

/**
 * Take a value snapshot from a live `PluginContext`.
 *
 * A method that throws or returns a value the wire cannot carry is skipped, not
 * fatal: the worker then falls back to the async proxy, so one misbehaving
 * service cannot break activation for every other service.
 */
export function takeSyncServiceSnapshot(context: Record<string, unknown>): SyncServiceSnapshot {
  const snapshot: SyncServiceSnapshot = Object.create(null) as SyncServiceSnapshot;
  for (const [serviceName, methods] of Object.entries(SYNC_SERVICE_METHODS)) {
    const implementation = context[serviceName] as Record<string, unknown> | undefined;
    if (!implementation) continue;
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const method of methods ?? []) {
      const candidate = implementation[method];
      if (typeof candidate !== 'function') continue;
      let value: unknown;
      try {
        value = (candidate as () => unknown).call(implementation);
      } catch {
        continue;
      }
      if (value instanceof Promise) {
        // "Sync" in the type but async in practice: it must not be frozen into a
        // snapshot, or the plugin would see a permanently stale value. Let the
        // async proxy serve the call instead.
        void value.catch(() => undefined);
        continue;
      }
      if (!isWireSafe(value)) continue;
      values[method] = value;
    }
    if (Object.keys(values).length > 0) snapshot[serviceName] = values;
  }
  return snapshot;
}

/**
 * Read the notification catalog so the worker can evaluate `declares(type)`
 * itself.
 *
 * The catalog is public information — `listPolicy()` already returns it to any
 * plugin — and the predicate is a straight exact/prefix match, so rebuilding it
 * next to the caller is behaviour-identical to calling the kernel service. This
 * is the one place a snapshot needs an `await`, because `declares` takes an
 * argument and therefore can never be reduced to a shipped value.
 */
export async function takeSyncServicePredicateInput(
  context: Record<string, unknown>,
): Promise<SyncServicePredicateInput> {
  const result: SyncServicePredicateInput = Object.create(null) as SyncServicePredicateInput;
  const policy = context['notificationPolicy'] as Record<string, unknown> | undefined;
  if (!policy) return result;
  const methods = SYNC_SERVICE_PREDICATES.notificationPolicy ?? [];
  if (methods.length === 0) return result;
  if (typeof policy['declares'] !== 'function') return result;
  const listPolicy = policy['listPolicy'];
  if (typeof listPolicy !== 'function') return result;
  try {
    const view = (await (listPolicy as () => Promise<unknown>).call(policy)) as
      { types?: Array<{ type?: unknown }> } | undefined;
    const types = (view?.types ?? [])
      .map((entry) => entry?.type)
      .filter((type): type is string => typeof type === 'string');
    if (types.length > 0) {
      const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const method of methods) {
        if (method === 'declares') values['declares'] = { types };
      }
      if (Object.keys(values).length > 0) result['notificationPolicy'] = values;
    }
  } catch {
    // Policy unavailable (no DB yet, service warming up): the worker falls back
    // to the async proxy, so `declares` still answers correctly — just slower.
  }
  return result;
}
