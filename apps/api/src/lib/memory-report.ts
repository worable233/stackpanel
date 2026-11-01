/**
 * 进程内存快照（`/ready` 与启动横幅用）。
 *
 * v0.1.1 线上排障的第二个盲区：装到 10+ 个插件后 web/worker 被 OOM 打出 500，
 * 但容器里**没有任何地方**能看到堆用了多少、上限是多少。运维只能
 * `docker exec … node -e 'v8.getHeapStatistics()'` 才知道，而这恰恰是 OOM 时
 * 最不可用的操作（容器正在被反复重启）。
 *
 * 把「已用 / 总量 / 上限 / RSS」放到 readiness 响应里，就能在 OOM 之前从外部监控
 * 看到趋势。字段语义：
 * - `heapUsed`：已分配的堆对象字节数，**持续单调上升**通常意味着泄漏；
 * - `heapTotal`：V8 已向操作系统申请的堆空间；
 * - `heapLimit`：`--max-old-space-size` 换算出的上限（未显式设置时 V8 按物理内存
 *   取默认值，容器里常见「限额的 50%」——这正是需要显式设置它的原因）；
 * - `rss`：整个进程的常驻集，含 Buffer / 原生分配，**OOM killer 看的是这个**。
 */
import v8 from 'node:v8';

export interface MemoryReport {
  heapUsed: number;
  heapTotal: number;
  heapLimit: number;
  rss: number;
}

/** 字节 → MiB（四舍五入），报告与日志都用这个口径。 */
export function toMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * 当前进程内存，单位 MiB。
 *
 * 用 `v8.getHeapStatistics().heap_size_limit` 而不是 `process.memoryUsage()` 里的
 * 派生值：前者直接反映 `--max-old-space-size`，是「还剩多少可用」的唯一准确来源。
 */
export function memoryReport(): MemoryReport {
  const usage = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  return {
    heapUsed: toMb(usage.heapUsed),
    heapTotal: toMb(usage.heapTotal),
    heapLimit: toMb(heap.heap_size_limit),
    rss: toMb(usage.rss),
  };
}

/**
 * 启动横幅的一行摘要。
 *
 * 显式打印 `heapLimit`：如果运维忘了给 `--max-old-space-size`，这一行会立刻暴露
 * 「上限只有容器限额的一半」，而不是等到 OOM 才去猜。
 */
export function describeMemory(report: MemoryReport = memoryReport()): string {
  return (
    `heap ${report.heapUsed}/${report.heapLimit} MiB` +
    ` (total ${report.heapTotal}) · rss ${report.rss} MiB`
  );
}

/**
 * 堆占用是否已到需要告警的水平（默认 85%）。
 *
 * 放在这里而不是内联，是为了让「什么算高」只有一个定义：`/ready` 用它决定是否
 * 附 `memoryPressure: true`，监控据此在 OOM 之前报警。
 */
export function memoryPressure(
  report: MemoryReport = memoryReport(),
  threshold = 0.85,
): boolean {
  if (report.heapLimit <= 0) return false;
  return report.heapUsed / report.heapLimit >= threshold;
}
