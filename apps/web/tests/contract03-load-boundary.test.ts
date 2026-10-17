import { describe, expect, it } from 'vitest';

/**
 * Contract 03 §5.1/§5.2 — the `try/catch import → null` boundary.
 *
 * The contract claims the load guard (`apps/web/src/lib/slots.ts` +
 * `pages.ts safeImportFrontend`) covers only:
 *   (a) module-load exceptions, and
 *   (b) async finder rejections,
 * while NOT covering top-level side effects, sync deadlocks, OOM, etc.
 *
 * These tests exercise that exact claim on the primitive the runtime uses, so
 * the boundary is proven rather than asserted.
 */

/** Mirrors `safeImportFrontend` (pages.ts): load failure downgrades to null. */
async function safeImport(load: () => Promise<unknown>): Promise<unknown | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

/** Mirrors the finder call sites: an async rejection downgrades to null. */
async function safeCall(fn: () => Promise<unknown>): Promise<unknown | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

describe('contract 03 §5.1 covered: load exception + async rejection', () => {
  it('covers a module-load exception by returning null', async () => {
    const result = await safeImport(() => import('./fixtures/contract03-throwing-module'));
    expect(result).toBeNull();
  });

  it('covers an async finder rejection by returning null', async () => {
    const result = await safeCall(async () => {
      throw new Error('finder rejected');
    });
    expect(result).toBeNull();
  });

  it('passes a successful finder value through', async () => {
    const result = await safeCall(async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });
});

describe('contract 03 §5.2 NOT covered: top-level side effects survive the guard', () => {
  it('does not roll back a side effect the module performed before throwing', async () => {
    const key = '__CONTRACT03_TOP_LEVEL_SIDE_EFFECT__';
    const result = await safeImport(() => import('./fixtures/contract03-throwing-module'));
    // The guard turned the load failure into null...
    expect(result).toBeNull();
    // ...but the module body already ran its side effect, and ESM caches the
    // errored module so it is never rolled back. The guard is a downgrade, not
    // a sandbox (contract 03 §5.2/§5.3).
    const sideEffect = (globalThis as Record<string, unknown>)[key] as number | undefined;
    expect(sideEffect).toBeGreaterThanOrEqual(1);
  });
});
