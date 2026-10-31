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
  // `\b` boundaries on the bare identifiers (`e` / `err` / `cause`) are load
  // bearing: `state.message` — the localized server-action result — contains the
  // substring `e.message`, so an unanchored pattern would flag legal action state.
  // The identifier-aware branch covers `someError.message` / `uploadFailure.message`,
  // which a plain alternation of exact names misses.
  /(?:toast\.[A-Za-z]+|setError)\s*\([^;\n]*(?:\b(?:e|err|cause)\b|[A-Za-z_$]*(?:[Ee]rr(?:or)?|[Cc]ause|[Ff]ailure|[Ee]xception))\.message\b/;

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

/**
 * Lock the matcher itself: the previous `(?:cause|error|err|…)` alternation was
 * case-sensitive and silently missed camelCase bindings (`loadError.message`),
 * which is exactly the shape external plugins use.
 */
const MUST_MATCH = [
  "setError(cause instanceof Error ? cause.message : tr('x'))",
  "setError(e instanceof Error ? e.message : tr('x'))",
  'setError(err.message)',
  'setError(error.message)',
  "setError(loadError instanceof Error ? loadError.message : tr('x'))",
  "setError(saveError instanceof Error ? saveError.message : tr('x'))",
  "setError(fetchError instanceof Error ? fetchError.message : tr('x'))",
  'toast.error(failure.message)',
];

const MUST_NOT_MATCH = [
  'if (result?.message) toast.success(result.message);',
  "toast.success(tr('feedback.saved'))",
];

describe('raw-message matcher catches camelCase bindings', () => {
  it.each(MUST_MATCH)('matches %s', (line) => {
    expect(RAW_MESSAGE_CALL.test(line)).toBe(true);
  });

  it.each(MUST_NOT_MATCH)('allows localized receipts: %s', (line) => {
    expect(RAW_MESSAGE_CALL.test(line)).toBe(false);
  });
});

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
