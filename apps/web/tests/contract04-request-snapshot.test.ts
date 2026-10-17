import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pinInSnapshot,
  resetFrontendSnapshot,
  runWithFrontendSnapshot,
} from '@/lib/frontend-snapshot';

/**
 * Contract 04 §3 — a request pins one deployment version.
 *
 * These tests exercise the snapshot primitive directly (the module is
 * `server-only`; the slot resolvers are covered elsewhere), so the invariant is
 * checked deterministically rather than through a live render.
 */

afterEach(() => {
  resetFrontendSnapshot();
});

describe('frontend request snapshot (contract 04 §3)', () => {
  it('resolves a surface once per request', async () => {
    const resolve = vi.fn(async () => 'rev-a');
    const first = await pinInSnapshot('theme', resolve);
    const second = await pinInSnapshot('theme', resolve);
    expect(first).toBe('rev-a');
    expect(second).toBe('rev-a');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('pins different surfaces independently', async () => {
    const theme = vi.fn(async () => 'rev-theme');
    const plugins = vi.fn(async () => ['rev-p1']);
    const [t, p] = await Promise.all([
      pinInSnapshot('theme', theme),
      pinInSnapshot('plugins', plugins),
    ]);
    expect(t).toBe('rev-theme');
    expect(p).toEqual(['rev-p1']);
    expect(theme).toHaveBeenCalledTimes(1);
    expect(plugins).toHaveBeenCalledTimes(1);
  });

  it('does not let two concurrent requests share a revision', async () => {
    const [a, b] = await Promise.all([
      runWithFrontendSnapshot(async () => pinInSnapshot('theme', async () => 'rev-a')),
      runWithFrontendSnapshot(async () => pinInSnapshot('theme', async () => 'rev-b')),
    ]);
    expect(a).toBe('rev-a');
    expect(b).toBe('rev-b');
  });

  it('a transient failure is not cached', async () => {
    const resolve = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('rev-ok');
    await expect(pinInSnapshot('theme', resolve)).rejects.toThrow('boom');
    await expect(pinInSnapshot('theme', resolve)).resolves.toBe('rev-ok');
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
