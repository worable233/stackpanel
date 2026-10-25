import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * Guard: inline feedback goes through `InlineError` / `InlineNotice`.
 *
 * 审计 §6 P4 的收尾项。手写 `<p role="alert" className="text-sm text-destructive">`
 * 有四个问题：颜色/字号各写一遍、容易漏 `role`（屏幕阅读器不播报）、
 * `alert` 与 `status` 语义混用（持续状态用 alert 会反复打断读屏）、
 * 以及「错误用 muted 灰字」这类视觉降级。
 *
 * 例外只有 UI 原语本身（`components/ui/*` 与 `packages/ui/src`），它们就是定义这些
 * role 的地方。
 */
const RAW_INLINE_ROLE = /<p[^>]*\brole="(?:alert|status)"/;

const SKIP_PATH =
  /(^|\/)(node_modules|dist|\.next|tests?|__tests__|fixtures?)(\/|$)|(^|\/)components\/ui\/|(^|\/)packages\/ui\/src\//;

const SCAN_ROOTS = [
  'apps/web/src',
  ...readdirSync(path.join(repoRoot, 'packages/plugins'))
    .map((id) => `packages/plugins/${id}/frontend/src`)
    .filter((dir) => {
      try {
        return statSync(path.join(repoRoot, dir)).isDirectory();
      } catch {
        return false;
      }
    }),
  ...readdirSync(path.join(repoRoot, 'packages/themes'))
    .map((id) => `packages/themes/${id}/frontend/src`)
    .filter((dir) => {
      try {
        return statSync(path.join(repoRoot, dir)).isDirectory();
      } catch {
        return false;
      }
    }),
];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(repoRoot, full);
    if (SKIP_PATH.test(relative)) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(relative);
  }
}

describe('inline feedback uses InlineError / InlineNotice', () => {
  it('has no hand-rolled <p role="alert|status"> in shipped frontends', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      const files: string[] = [];
      walk(path.join(repoRoot, root), files);
      for (const file of files) {
        readFileSync(path.join(repoRoot, file), 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (RAW_INLINE_ROLE.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
