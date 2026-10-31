import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * 行内反馈必须走 `InlineError` / `InlineNotice`。
 *
 * 手写 `<p role="alert" className="text-sm text-destructive">` 有四个问题：颜色/字号各写
 * 一遍、容易漏 `role`（屏幕阅读器不播报）、`alert` 与 `status` 语义混用（持续状态用
 * `alert` 会反复打断读屏）、以及「错误用 muted 灰字」这类视觉降级。
 *
 * 匹配**整份文件**而不是逐行：多行 JSX 把 `role` 写在单独一行同样要拦（插件仓库的
 * `check-feedback.mjs` 曾因为逐行匹配漏掉 referral 的多行 `<p role="status">`）。
 *
 * 两类豁免：
 *   - UI 原语本身（`components/ui/*`、`packages/ui/src`），它们就是定义这些 role 的地方；
 *   - 带 `aria-label` 的 `role="status"` 区域（骨架屏、加载容器）：那是「区域播报」，
 *     不是行内回执，换成 `<p>` 包裹块级占位反而不合法。
 */
const NATIVE_TAGS = 'p|div|span|section|li';
const ELEMENT = new RegExp(`<(${NATIVE_TAGS})\\b([^>]*)>`, 'g');

/** 返回所有违规元素的起始偏移，供测试报告行号。 */
export function rawInlineRoles(source: string): number[] {
  const offsets: number[] = [];
  for (const match of source.matchAll(ELEMENT)) {
    const attributes = match[2] ?? '';
    if (!/\brole="(?:alert|status)"/.test(attributes)) continue;
    if (/\baria-label=/.test(attributes)) continue;
    offsets.push(match.index ?? 0);
  }
  return offsets;
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

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

describe('inline feedback matcher', () => {
  it('flags hand-rolled role on native elements and on their own line', () => {
    expect(rawInlineRoles('<p role="alert" className="text-sm">x</p>')).toHaveLength(1);
    expect(rawInlineRoles('<div\n  role="status"\n  className="mt-2"\n>x</div>')).toHaveLength(1);
    expect(rawInlineRoles('<li role="alert">x</li>')).toHaveLength(1);
  });

  it('leaves components that own the role alone', () => {
    expect(rawInlineRoles('<InlineError>{error}</InlineError>')).toEqual([]);
    expect(rawInlineRoles('<FieldError role="alert">{error}</FieldError>')).toEqual([]);
  });

  it('leaves labelled live regions alone', () => {
    expect(
      rawInlineRoles('<div role="status" aria-label={t("loading")}><Skeleton /></div>'),
    ).toEqual([]);
  });
});

describe('inline feedback uses InlineError / InlineNotice', () => {
  it('has no hand-rolled role="alert|status" on native elements in shipped frontends', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      const files: string[] = [];
      walk(path.join(repoRoot, root), files);
      for (const file of files) {
        const source = readFileSync(path.join(repoRoot, file), 'utf8');
        for (const offset of rawInlineRoles(source)) {
          offenders.push(`${file}:${lineOf(source, offset)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
