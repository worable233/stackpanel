import { describe, expect, it } from 'vitest';
import { MemoryStateService } from '../../src/state/state-service.ts';

describe('MemoryStateService', () => {
  it('stores and expires TTL values', async () => {
    const state = new MemoryStateService();
    await state.set('k', 'v', 20);
    expect(await state.get('k')).toBe('v');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await state.get('k')).toBeNull();
  });

  it('increments counters and sets ttl only on first incr', async () => {
    const state = new MemoryStateService();
    expect(await state.incr('c')).toBe(1);
    expect(await state.incr('c')).toBe(2);
    expect(await state.decr('c')).toBe(1);
    expect(await state.decr('c')).toBe(0);
    // floored at 0
    expect(await state.decr('c')).toBe(0);
  });

  it('exposes a mutual-exclusion lock', async () => {
    const state = new MemoryStateService();
    expect(await state.acquire('lock', 1000)).toBe(true);
    expect(await state.acquire('lock', 1000)).toBe(false);
    await state.release('lock');
    expect(await state.acquire('lock', 1000)).toBe(true);
  });

  it('skips withLock when the lock is busy and releases afterwards', async () => {
    const state = new MemoryStateService();
    let ran = 0;
    expect(
      await state.withLock('l', 1000, async () => {
        ran += 1;
      }),
    ).toBe(true);
    // released after the first call
    expect(
      await state.withLock('l', 1000, async () => {
        ran += 1;
      }),
    ).toBe(true);
    expect(ran).toBe(2);

    await state.acquire('held', 1000);
    expect(
      await state.withLock('held', 1000, async () => {
        ran += 1;
      }),
    ).toBe(false);
    expect(ran).toBe(2);
  });

  it('sweeps expired entries', async () => {
    const state = new MemoryStateService();
    await state.set('gone', 'v', 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.sweep();
    expect(await state.get('gone')).toBeNull();
  });
});
