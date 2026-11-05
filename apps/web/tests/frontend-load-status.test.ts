import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * P1-A 守卫：插件前端**运行期装载失败**必须在管理列表里可见。
 *
 * 装载失败发生在 web 进程，列表由 api 进程生成（两者不共享内存）。线上 v0.1.3
 * 里 llm-gateway 的前端完全装载失败（`SyntaxError: does not provide an export
 * named`），而后台「插件管理」照旧显示「已激活」—— 管理员完全无从察觉。
 *
 * 跨进程的唯一通道是共享数据目录下的状态文件。
 */

/**
 * 这些用例首次 import 时会加载 `@stackpanel/ui` 整桶（客户端与服务端两份）。
 * 单跑约 1.4s，但 `pnpm -r test` 全量并行时会被 CPU 争用拖到 5s+（实测打穿默认 5s超时）。
 * 这里测的是语义，不是速度，给出显式预算。
 */
const HEAVY_IMPORT_TIMEOUT = 30_000;

describe('前端装载失败的跨进程可见性（P1-A）', { timeout: HEAVY_IMPORT_TIMEOUT }, () => {
  it('装载失败写成共享状态文件，并带真实原因', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-p1a-'));
    const previous = process.env.STACKPANEL_DATA_DIR;
    process.env.STACKPANEL_DATA_DIR = dir;
    try {
      const { recordFrontendLoadFailure } = await import('@/lib/frontend-runtime');
      recordFrontendLoadFailure('plugins', 'llm-gateway', 'does not provide an export named');

      const target = path.join(dir, 'runtime-frontend-status', 'plugins-llm-gateway.json');
      expect(existsSync(target)).toBe(true);
      const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
        message?: unknown;
        kind?: unknown;
        id?: unknown;
      };
      // 原因必须原样保留：界面 title 直接给运维看。
      expect(parsed.message).toBe('does not provide an export named');
      expect(parsed.kind).toBe('plugins');
      expect(parsed.id).toBe('llm-gateway');
    } finally {
      if (previous === undefined) delete process.env.STACKPANEL_DATA_DIR;
      else process.env.STACKPANEL_DATA_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('装载失败的真实路径上确实调用了写盘（钩子不能只存在、要被接上）', async () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/frontend-runtime.ts'), 'utf8');
    // 存在写盘函数但没在 catch 里调用 = 一个永远不会生效的钩子。
    expect(source).toContain('recordFrontendLoadFailure(kind, id, message)');
    // 且必须在失败分支（写入失败缓存之后）。
    const failIdx = source.indexOf('failureCache().set(entry, { message, at: Date.now() })');
    const callIdx = source.indexOf('recordFrontendLoadFailure(kind, id, message)');
    expect(failIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(failIdx);
  });

  it('写盘失败不抛（不能反过来打挂本已出错的页面）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-p1a-bad-'));
    const previous = process.env.STACKPANEL_DATA_DIR;
    // 把数据目录指到一个**文件**上：mkdirSync 必然失败。
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, '');
    process.env.STACKPANEL_DATA_DIR = blocker;
    try {
      const { recordFrontendLoadFailure } = await import('@/lib/frontend-runtime');
      expect(() => recordFrontendLoadFailure('plugins', 'x', 'boom')).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.STACKPANEL_DATA_DIR;
      else process.env.STACKPANEL_DATA_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
