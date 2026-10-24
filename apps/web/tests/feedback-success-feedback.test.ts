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
 * receipt: inline result, redirect, or its own toast). Without this, a save can
 * succeed with no visible confirmation — the audit's §3.1 finding.
 *
 * This scans kernel-shipped plugin/theme sources. External plugin repos run the
 * same test against their own sources.
 */
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
  if (hasFeedback === hasSilent) {
    const { line } = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    findings.push({ id, file: path.relative(repoRoot, file), line: line + 1 });
  }
}

describe('mutating frontend actions declare success feedback', () => {
  it('each POST/PATCH/DELETE action has successFeedback xor silent', () => {
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
