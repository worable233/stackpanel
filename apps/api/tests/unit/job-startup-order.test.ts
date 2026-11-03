import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Z-4：插件定时任务在 worker 侧死信。
 *
 * 现场表现：「自动同步商品」从不执行，死信里全是「本副本无处理器」。
 *
 * 根因不是「worker 解析不到插件模型」（那是另一条，已由 model 快照注入解决），
 * 而是**启动顺序**：
 *
 *   1. `initInfra()` → `initJobs()` → `runtime.start()` 立刻开始消费队列；
 *   2. 插件的 `onActivate`（注册 `scheduled-sync` 等 handler）要等到
 *      `syncEnabledPlugins()` 才跑。
 *
 * 窗口里到达的任务找不到 handler，被当作「本副本无处理器」退回重试，重试耗尽
 * 进死信。任务本身没问题，是消费者抢在生产者注册之前就开工了。
 *
 * 修复：`initJobs` 只 attach backend，消费由 `startJobConsumption()` 在插件
 * 激活完成后显式启动 —— 与 outbox 消费已有的处理方式一致。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

describe('job consumption waits for plugin handlers', () => {
  const jobs = read('src/jobs/index.ts');

  it('exposes an explicit start step', () => {
    expect(jobs).toContain('export async function startJobConsumption');
  });

  it('does not auto-start when the caller asked to defer', () => {
    expect(jobs).toContain('deferConsumption');
    expect(jobs).toMatch(/if \(!options\.deferConsumption\) await runtime\.start\(\)/);
  });

  it('infra defers so plugins can register first', () => {
    const infra = read('src/infra.ts');
    expect(infra).toContain('deferConsumption: true');
  });
});

describe('both entrypoints start consumption after plugin activation', () => {
  for (const entry of ['src/worker.ts', 'src/normal-start.ts']) {
    it(`${entry} starts it after syncEnabledPlugins`, () => {
      const source = read(entry);
      const activation = source.indexOf('syncEnabledPlugins()');
      const start = source.indexOf('startJobConsumption()');
      expect(activation).toBeGreaterThan(-1);
      expect(start).toBeGreaterThan(-1);
      // 顺序是关键：先激活插件（注册 handler），再开始消费。
      expect(start).toBeGreaterThan(activation);
    });
  }

  it('the worker explains why the order matters', () => {
    // 这条顺序很容易在后续重构中被“整理”回去，注释是唯一的路障。
    expect(read('src/worker.ts')).toMatch(/死信|无处理器/);
  });
});
