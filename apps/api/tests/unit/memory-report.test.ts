import { describe, expect, it } from 'vitest';
import { describeMemory, memoryPressure, memoryReport, toMb } from '../../src/lib/memory-report.ts';

/**
 * 内存可观测性（v0.1.1 OOM 盲区）。
 *
 * 线上形态：装到 10+ 个插件后 web/worker 被 OOM 打出 500，容器反复重启，连
 * `docker exec` 都进不去——而当时**没有任何外部可见的堆用量**。这组用例锁住
 * `/ready` 与启动横幅依赖的那几个数值的语义。
 */

describe('toMb', () => {
  it('rounds bytes to whole MiB', () => {
    expect(toMb(1024 * 1024)).toBe(1);
    expect(toMb(1024 * 1024 * 1.4)).toBe(1);
    expect(toMb(1024 * 1024 * 1.6)).toBe(2);
    expect(toMb(0)).toBe(0);
  });
});

describe('memoryReport', () => {
  it('reports every field the readiness probe publishes, in MiB', () => {
    const report = memoryReport();
    for (const field of ['heapUsed', 'heapTotal', 'heapLimit', 'rss'] as const) {
      expect(typeof report[field], field).toBe('number');
      expect(Number.isFinite(report[field]), field).toBe(true);
      expect(report[field], field).toBeGreaterThanOrEqual(0);
    }
    // 单位必须是 MiB 而不是字节：字节值会让「256MB 堆」看起来像天文数字。
    expect(report.heapLimit).toBeLessThan(1024 * 1024);
  });

  it('reports a real heap limit, not zero — this is the number that exposes a missing --max-old-space-size', () => {
    // 未显式设置时 V8 仍会给出一个默认上限（约物理内存的一半）；`0` 只可能来自
    // 读错字段，那种情况运维会以为「没有上限」。
    expect(memoryReport().heapLimit).toBeGreaterThan(0);
  });
});

describe('describeMemory', () => {
  it('prints used/limit so a missing NODE_OPTIONS is obvious at boot', () => {
    const line = describeMemory({ heapUsed: 120, heapTotal: 200, heapLimit: 768, rss: 300 });
    expect(line).toContain('heap 120/768 MiB');
    expect(line).toContain('rss 300 MiB');
    expect(line).toContain('total 200');
  });
});

describe('memoryPressure', () => {
  it('flags a heap at or above the threshold', () => {
    expect(memoryPressure({ heapUsed: 680, heapTotal: 700, heapLimit: 768, rss: 900 })).toBe(true);
    expect(memoryPressure({ heapUsed: 650, heapTotal: 700, heapLimit: 768, rss: 900 })).toBe(false);
  });

  it('honours a custom threshold', () => {
    const report = { heapUsed: 500, heapTotal: 600, heapLimit: 1000, rss: 700 };
    expect(memoryPressure(report, 0.5)).toBe(true);
    expect(memoryPressure(report, 0.9)).toBe(false);
  });

  it('never reports pressure when there is no measurable limit', () => {
    // 除零防护：`heapLimit: 0` 不能让 readiness 变成 `NaN >= 0.85` 的未定义行为。
    expect(memoryPressure({ heapUsed: 1, heapTotal: 1, heapLimit: 0, rss: 1 })).toBe(false);
  });
});
