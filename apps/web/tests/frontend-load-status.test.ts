import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * P1-A 守卫：插件前端**运行期装载失败**必须在管理列表里可见。
 *
 * 装载失败发生在 web 进程，列表由 api 进程生成。线上 v0.1.3 里 llm-gateway 的
 * 前端完全装载失败（`SyntaxError: does not provide an export named`），而后台
 * 「插件管理」照旧显示「已激活」—— 管理员完全无从察觉。
 */

describe('前端装载失败的跨进程可见性（P1-A）', () => {
  it('web 侧把装载失败写成共享状态文件', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-p1a-'));
    const previous = process.env.STACKPANEL_DATA_DIR;
    process.env.STACKPANEL_DATA_DIR = dir;
    try {
      // 直接调用写盘函数：它挂在真实的装载失败路径上（`loadRuntimeFrontend`）。
      const mod = await import('@/lib/frontend-runtime');
      const write = (mod as unknown as { recordFrontendLoadFailure?: unknown })
        .recordFrontendLoadFailure;
      // 函数可以是私有的；用端到端路径验证更稳：失败一次，看文件出现。
      if (typeof write === 'function') {
        (write as (a: string, b: string, c: string) => void)('plugins', 'llm-gateway', 'boom');
      } else {
        // 私有函数：走真实装载路径，制造一个必然失败的入口。
        mkdirSync(path.join(dir, 'plugins', 'broken-pkg', 'frontend', 'dist'), { recursive: true });
        writeFileSync(
          path.join(dir, 'plugins', 'broken-pkg', 'frontend', 'dist', 'index.js'),
          'this is not valid javascript {{',
        );
        await mod.loadRuntimeFrontend('plugins', 'broken-pkg');
      }
      const statusFile = path.join(dir, 'runtime-frontend-status', 'plugins-llm-gateway.json');
      const { readFileSync, existsSync } = await import('node:fs');
      const target = existsSync(statusFile)
        ? statusFile
        : path.join(dir, 'runtime-frontend-status', 'plugins-broken-pkg.json');
      expect(existsSync(target), '装载失败必须落盘').toBe(true);
      const parsed = JSON.parse(readFileSync(target, 'utf8')) as { message?: unknown };
      // 失败原因要能定位（P1-B 同源诉求）。
      expect(typeof parsed.message).toBe('string');
      expect((parsed.message as string).length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.STACKPANEL_DATA_DIR;
      else process.env.STACKPANEL_DATA_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
