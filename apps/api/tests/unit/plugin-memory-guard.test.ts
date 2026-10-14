import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PLUGIN_MAX_RSS_MB,
  MEMORY_GUARD_INTERVAL_MS,
  maxRssMb,
  resolveMaxRssMb,
  startMemoryGuard,
} from '../../src/plugins/isolated/memory-guard.ts';

describe('plugin memory guard (audit C-2)', () => {
  describe('resolveMaxRssMb', () => {
    it('falls back to the default for missing/invalid/non-positive values', () => {
      for (const raw of [undefined, '', 'abc', '0', '-1', Number.NaN]) {
        expect(resolveMaxRssMb(raw as string | number | undefined)).toBe(DEFAULT_PLUGIN_MAX_RSS_MB);
      }
    });

    it('truncates a positive configured value', () => {
      expect(resolveMaxRssMb('512')).toBe(512);
      expect(resolveMaxRssMb('300.9')).toBe(300);
      expect(resolveMaxRssMb(256)).toBe(256);
    });
  });

  it('converts a resourceUsage reading (KiB) to MiB', () => {
    expect(maxRssMb({ maxRSS: 1024 })).toBe(1);
    expect(maxRssMb({ maxRSS: 512 * 1024 })).toBe(512);
  });

  it('does not start a timer when disabled (<= 0)', () => {
    const setIntervalFn = vi.fn();
    const guard = startMemoryGuard({ maxRssMb: 0, onExceed: vi.fn(), setIntervalFn });
    expect(setIntervalFn).not.toHaveBeenCalled();
    guard.stop();
  });

  it('invokes onExceed exactly once when the ceiling is crossed', () => {
    const onExceed = vi.fn();
    let tick: (() => void) | undefined;
    const clearIntervalFn = vi.fn();
    startMemoryGuard({
      maxRssMb: 100,
      readMaxRssMb: () => 250,
      onExceed,
      setIntervalFn: ((fn: () => void) => {
        tick = fn;
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearIntervalFn,
    });

    tick?.();
    expect(onExceed).toHaveBeenCalledWith(250);
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);

    // A second tick after the trip must not fire again.
    tick?.();
    expect(onExceed).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while under the ceiling', () => {
    const onExceed = vi.fn();
    const guard = startMemoryGuard({
      maxRssMb: 512,
      readMaxRssMb: () => 100,
      onExceed,
      intervalMs: MEMORY_GUARD_INTERVAL_MS,
      setIntervalFn: ((fn: () => void) => {
        fn();
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearIntervalFn: vi.fn(),
    });
    expect(onExceed).not.toHaveBeenCalled();
    guard.stop();
  });
});
