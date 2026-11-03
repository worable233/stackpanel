import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `/plugins/frontends` 的性能 P0。
 *
 * 现场数据（线上 25,106 行 api 日志按 reqId 聚合）：
 *   n=379  p50=160ms  p95=8892ms  max=10025ms
 *
 * 它不是慢查询：没有触到数据库。原因是每次请求都对 23 个 active 插件做
 * 「stat 目录 + 读 manifest + 读 revision 指针 + 必要时重建产物」，上百次
 * 文件系统操作，而这个列表在两次插件变更之间完全不变。它又是每个页面渲染
 * 都要拉的公共依赖，于是 IO 抖动直接放大成页面卡顿。
 *
 * 缓存的关键在失效，不在存储：漏失效会拿到已经不存在的 revision，或者漏掉
 * 刚装上的插件。这里用运行时的代际号作键，避免在每处生命周期出口各写一次
 * `cache.clear()`。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

describe('frontends cache is keyed on runtime generation', () => {
  const source = read('src/routes/plugin.ts');

  it('caches the assembled list instead of re-walking the filesystem per request', () => {
    expect(source).toContain('frontendsCache');
    expect(source).toContain('FRONTENDS_CACHE_TTL_MS');
    // 命中路径必须在扫盘之前返回。
    const handlerStart = source.indexOf("app.get('/plugins/frontends'");
    const firstAwait = source.indexOf('await ', handlerStart);
    const earlyReturn = source.indexOf('return frontendsCache.body', handlerStart);
    expect(earlyReturn).toBeGreaterThan(handlerStart);
    expect(earlyReturn).toBeLessThan(firstAwait);
  });

  it('invalidates when the active plugin set changes', () => {
    expect(source).toContain('app.pluginRuntime.combinedGeneration');
    const runtime = read('src/plugins/runtime.ts');
    expect(runtime).toContain('get combinedGeneration()');
    // 激活 / 关闸 / 激活失败都必须推进代际号，否则缓存会长期陈旧。
    const bumps = runtime.match(/this\.generation \+= 1/g) ?? [];
    expect(bumps.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps a short TTL as a backstop for out-of-band file changes', () => {
    // 插件集合不变但目录内容被替换（升级、手工修产物）时，代际号不会变。
    const ttl = /FRONTENDS_CACHE_TTL_MS = (\d[\d_]*)/.exec(source);
    expect(ttl).not.toBeNull();
    const ms = Number((ttl?.[1] ?? '0').replace(/_/g, ''));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(60_000);
  });
});

describe('generation actually advances on lifecycle transitions', () => {
  const runtime = read('src/plugins/runtime.ts');

  it('bumps on successful activation', () => {
    expect(runtime).toMatch(/plugin\.state = 'active';[\s\S]{0,120}this\.generation \+= 1;/);
  });

  it('bumps when a plugin is gated off during deactivation', () => {
    // 关闸这一步之后该插件就不该再出现在前端清单里。
    expect(runtime).toMatch(/plugin\.state = 'registered';[\s\S]{0,200}this\.generation \+= 1;/);
  });

  it('bumps when activation fails and the plugin falls back to registered', () => {
    expect(runtime).toMatch(
      /state !== 'failed'\) plugin\.state = 'registered';[\s\S]{0,80}this\.generation \+= 1;/,
    );
  });
});
