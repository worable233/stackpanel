import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 审计 P1-2 / P1-3：忙轮询与性能可观测性。
 *
 * P1-2 证据（pg_stat_user_tables）：
 *   outbox_events        601 行, seq_scan 169,098
 *   event_cursors         11 行, seq_scan 158,949
 *   agent_dispatches       0 行, seq_scan  63,793
 *
 * 对 11 行 / 0 行的表做十几万次全表扫描 = 忙轮询。
 *
 * P1-3：原先只有 pino `responseTime` 行，没有按路由的分位、没有上游耗时 ——
 * 这次审计靠临时脚本聚合日志才拿到数据，下次还得再写一遍脚本。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

describe('outbox polling backs off when idle', () => {
  const events = read('src/plugins/events.ts');

  it('uses a self-rescheduling timer instead of a fixed interval', () => {
    // 固定 setInterval 在空表上就是忙轮询，无法按「有没有活」调整。
    const block = events.slice(events.indexOf('startConsumption(): boolean'));
    expect(block.slice(0, 2200)).toContain('setTimeout');
    expect(block.slice(0, 2200)).not.toContain('setInterval(');
  });

  it('grows the interval while idle and resets on delivery', () => {
    const block = events.slice(events.indexOf('startConsumption(): boolean'));
    // 有活 → 回到基础间隔；没活 → 翻倍且封顶。
    expect(block.slice(0, 2600)).toMatch(/delivered > 0[\s\S]{0,200}baseInterval/);
    expect(block.slice(0, 2600)).toContain('Math.min(maxInterval');
  });

  it('caps the delay so events are never starved', () => {
    const block = events.slice(events.indexOf('startConsumption(): boolean'));
    expect(block).toMatch(/catchUpMaxIntervalMs \?\? 30_000/);
  });

  it('keeps scheduling after a failed pass so one error cannot halt delivery', () => {
    const block = events.slice(events.indexOf('startConsumption(): boolean'));
    const catchBlock = block.slice(block.indexOf('.catch((err) =>'));
    expect(catchBlock.slice(0, 400)).toContain('schedule()');
  });
});

describe('indexes match what the relay actually filters on', () => {
  const schema = read('../../packages/db/prisma/schema.prisma');

  it('covers the parkedAt predicate the scan uses', () => {
    // relay 的 WHERE 是 publishedAt IS NULL AND parkedAt IS NULL AND ...，
    // 前三个索引都不含 parkedAt。
    expect(schema).toContain('@@index([publishedAt, parkedAt, nextAttemptAt])');
  });
});

describe('upstream latency is measurable', () => {
  const metrics = read('src/observability/metrics.ts');
  const observability = read('src/observability/index.ts');

  it('registers an upstream duration histogram', () => {
    expect(metrics).toContain('stackpanel_upstream_request_duration_seconds');
    expect(metrics).toContain('upstreamRequestDurationSeconds');
  });

  it('labels it by plugin/upstream/outcome with bounded cardinality', () => {
    expect(metrics).toMatch(/labelNames: \['plugin', 'upstream', 'outcome'\]/);
  });

  it('records failures too, not only successes', () => {
    // 上游慢通常伴随超时；只统计成功的会让最该看的那部分消失。
    const helper = observability.slice(observability.indexOf('export async function observeUpstream'));
    expect(helper).toContain("record('error')");
    expect(helper).toContain("record('ok')");
  });

  it('spreads buckets up to 30s because upstream calls are seconds-scale', () => {
    // 实测单次 1.8~2.3s；桶如果只铺到 1s，最长的那批会全堆在 +Inf。
    const buckets = /UPSTREAM_DURATION_BUCKETS = \[([^\]]+)\]/.exec(metrics);
    expect(buckets).not.toBeNull();
    const values = (buckets?.[1] ?? '').split(',').map((value) => Number(value.trim()));
    expect(Math.max(...values)).toBeGreaterThanOrEqual(20);
    expect(values).toContain(2);
  });
});
