import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * Guard: user-facing feedback must never interpolate a raw exception message.
 *
 * `Error.message` carries server prose (`fetch failed`, `SignatureDoesNotMatch`,
 * upstream SQL text …) that is not localized and may leak internals. We only
 * scan the feedback channels — `toast.*` and `setError(...)` — where the audit
 * found the leaks; localized action results (`result.message`) remain allowed.
 */
const RAW_MESSAGE_CALL =
  // `\be` 的词边界不能省：`state.message`（server action 的本地化结果）里含
  // `e.message` 子串，没有边界会把合法的 action state 误判成泄漏。
  /(?:toast\.[A-Za-z]+|setError)\s*\([^;\n]*(?:cause|error|err|failure|exception|\be)\.message/;

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

/** Tests, fixtures and the spike sandbox are not shipped feedback code. */
const SKIP_PATH = /(^|\/)(node_modules|dist|\.next|tests?|__tests__|fixtures?|\(spike\))(\/|$)/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(repoRoot, full);
    if (SKIP_PATH.test(relative)) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(relative);
  }
}

describe('feedback never renders raw exception messages', () => {
  it('keeps toast/setError calls free of *.message', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      const files: string[] = [];
      walk(path.join(repoRoot, root), files);
      for (const file of files) {
        const lines = readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (RAW_MESSAGE_CALL.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
