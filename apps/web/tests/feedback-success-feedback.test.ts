import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * Guard: every mutating frontend action declares how success is acknowledged.
 *
 * A `POST`/`PATCH`/`DELETE` action must carry either `successFeedback` (the host
 * shows a localized toast) or `silent: true` (the package already gives a
 * receipt: inline state, redirect, or its own toast). Without this, a save can
 * succeed with no visible confirmation — the audit's §3.1 finding.
 *
 * `INLINE_RECEIPT_ACTIONS` is the third, explicit form: since the executor now
 * *resolves* `{ ok, message?, error? }` (docs/design/feedback-ux-handoff.md §4.1),
 * a package may render its own persistent receipt instead of asking the host for
 * a toast. Each entry must name the component that renders it, so 「谁给了回执」
 * stays checkable instead of becoming an untracked exemption.
 *
 * This scans kernel-shipped plugin/theme sources. External plugin repos run the
 * same test against their own sources.
 */
const INLINE_RECEIPT_ACTIONS: Record<string, string> = {
  'market.install-plugin': 'plugins/market/frontend/src/admin.tsx（行内「已安装 x.y.z」/ 精确失败原因）',
  'market.install-theme': 'plugins/market/frontend/src/admin.tsx（行内「已安装 x.y.z」/ 精确失败原因）',
  'market.refresh-catalog': 'plugins/market/frontend/src/admin.tsx（「刷新目录」按钮旁的行内「目录已刷新」/ 限流与取不到的错误码）',
};
const SCAN_ROOTS = [
  ...readdirSync(path.join(repoRoot, 'packages/plugins')).map(
    (id) => `packages/plugins/${id}/frontend/src`,
  ),
  ...readdirSync(path.join(repoRoot, 'packages/themes')).map(
    (id) => `packages/themes/${id}/frontend/src`,
  ),
];

const MUTATING = new Set(['POST', 'PATCH', 'DELETE']);

function walk(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function stringValue(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteral(node) ? node.text : null;
}

interface Finding {
  id: string;
  file: string;
  line: number;
}

function scanAction(node: ts.ObjectLiteralExpression, file: string, findings: Finding[]): void {
  const props = new Map<string, ts.PropertyAssignment>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name) props.set(name, property);
  }
  const method = stringValue(props.get('method')?.initializer);
  const id = stringValue(props.get('id')?.initializer);
  const actionPath = stringValue(props.get('path')?.initializer);
  if (!method || !id || !actionPath || !MUTATING.has(method)) return;

  const hasFeedback = props.has('successFeedback');
  const hasSilent = props.has('silent');
  if (hasFeedback && hasSilent) {
    const { line } = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    findings.push({ id, file: path.relative(repoRoot, file), line: line + 1 });
    return;
  }
  if (!hasFeedback && !hasSilent && !(id in INLINE_RECEIPT_ACTIONS)) {
    const { line } = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    findings.push({ id, file: path.relative(repoRoot, file), line: line + 1 });
  }
}

describe('mutating frontend actions declare success feedback', () => {
  it('each POST/PATCH/DELETE action has successFeedback, silent, or an inline receipt', () => {
    const findings: Finding[] = [];
    for (const root of SCAN_ROOTS) {
      const files: string[] = [];
      walk(path.join(repoRoot, root), files);
      for (const file of files) {
        const source = ts.createSourceFile(
          file,
          readFileSync(file, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );
        const visit = (node: ts.Node): void => {
          if (ts.isObjectLiteralExpression(node)) scanAction(node, file, findings);
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
    expect(findings.map((finding) => `${finding.file}:${finding.line} ${finding.id}`)).toEqual([]);
  });
});
