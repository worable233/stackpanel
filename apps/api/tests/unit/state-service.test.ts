import { describe, expect, it } from 'vitest';
import { MemoryStateService } from '../../src/state/state-service.ts';
import { present } from '../helpers.ts';

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

  it('reports the remaining TTL so a throttle can say how long to wait', async () => {
    const state = new MemoryStateService();
    await state.set('ttl:warm', 'v', 60_000);
    const remaining = await state.ttl('ttl:warm');
    expect(remaining).toBeGreaterThan(55_000);
    expect(remaining).toBeLessThanOrEqual(60_000);

    // Missing key and no-expiry key are distinct: `0` means "gone", `null` means
    // "present forever". Collapsing them would make a permanent key look expired.
    await state.set('ttl:forever', 'v');
    expect(await state.ttl('ttl:forever')).toBeNull();
    expect(await state.ttl('ttl:absent')).toBe(0);
  });

  it('exposes a mutual-exclusion lock', async () => {
    const state = new MemoryStateService();
    const token = await state.acquire('lock', 1000);
    expect(token).toEqual(expect.any(String));
    expect(await state.acquire('lock', 1000)).toBeNull();
    expect(await state.release('lock', token as string)).toBe(true);
    expect(await state.acquire('lock', 1000)).toEqual(expect.any(String));
  });

  it('cannot release another owner lock', async () => {
    const state = new MemoryStateService();
    const token = await state.acquire('owned', 1000);
    expect(await state.release('owned', 'wrong-token')).toBe(false);
    expect(await state.get('owned')).toBe(token);
    expect(await state.release('owned', token as string)).toBe(true);
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

  it('acquires the first candidate pool with a free seat', async () => {
    const state = new MemoryStateService();
    const a = { key: 'a', limit: 1 };
    const b = { key: 'b', limit: 1 };
    const first = await state.acquireLease([a, b]);
    expect(first?.key).toBe('a');
    // `a` is full, so the next call falls through to `b`.
    const second = await state.acquireLease([a, b]);
    expect(second?.key).toBe('b');
    expect(await state.acquireLease([a, b])).toBeNull();
  });

  it('treats a non-positive limit as unlimited', async () => {
    const state = new MemoryStateService();
    const pool = { key: 'unbounded', limit: 0 };
    expect((await state.acquireLease([pool]))?.key).toBe('unbounded');
    expect((await state.acquireLease([pool]))?.key).toBe('unbounded');
  });

  it('releases and renews seats by token, and never revives a lost seat', async () => {
    const state = new MemoryStateService();
    const pool = { key: 'pool', limit: 1 };
    const lease = present(await state.acquireLease([pool], 60_000));
    // A foreign token must not release someone else's seat.
    expect(await state.releaseLease({ key: 'pool', token: 'foreign' })).toBe(false);
    expect(await state.acquireLease([pool])).toBeNull();
    expect(await state.renewLease(lease, 60_000)).toBe(true);
    expect(await state.releaseLease(lease)).toBe(true);
    expect(await state.renewLease(lease, 60_000)).toBe(false);
    // Freed by its owner, so the seat is available again.
    expect(await state.acquireLease([pool])).not.toBeNull();
  });

  it('reclaims seats whose TTL elapsed', async () => {
    const state = new MemoryStateService();
    const pool = { key: 'expiring', limit: 1 };
    expect(await state.acquireLease([pool], 1)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reclaimed = await state.acquireLease([pool], 1);
    expect(reclaimed).not.toBeNull();
  });

  it('returns null for an empty candidate list', async () => {
    expect(await new MemoryStateService().acquireLease([])).toBeNull();
  });
});
