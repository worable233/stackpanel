/**
 * Regression: the media pipeline must be able to load `sharp` in a **tsx** process.
 *
 * `apps/api/tsconfig.json` once carried a `paths` mapping for `sharp` that
 * pointed at its `.d.ts`. TypeScript-only intent, runtime effect: `tsx` honours
 * tsconfig `paths` at runtime, so `import('sharp')` executed a declarations file
 * and threw `ReferenceError: sharp is not defined`. `createSharpTransformer`
 * swallows encoder failures by design ("best effort, never block an upload"), so
 * every image variant silently ended up `failed` with 编码未产出字节 — while this
 * suite stayed green, because vitest resolves through vite (which ignores that
 * mapping) instead of tsx.
 *
 * This test runs the real dev-time loader (`tsx` with the api tsconfig) and would
 * have failed on the broken commit. Keep it: no other test covers that path.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const apiDir = process.cwd();
const tsxBin = path.join(apiDir, 'node_modules', '.bin', 'tsx');
const hasTsx = existsSync(tsxBin);

describe.skipIf(!hasTsx)('tsx runtime module resolution (image encoder)', () => {
  it('loads the sharp factory instead of a declaration file', () => {
    // A scratch dir INSIDE apps/api so tsx resolves the project tsconfig — the
    // exact condition that broke in dev.
    const dir = mkdtempSync(path.join(apiDir, '.sp-tsx-probe-'));
    const entry = path.join(dir, 'probe.mts');
    writeFileSync(
      entry,
      [
        "const mod = await import('sharp');",
        "if (typeof mod.default !== 'function') {",
        "  console.error('sharp default export is not callable');",
        '  process.exit(2);',
        '}',
        "console.log('ok');",
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      // `TMPDIR` is overridden so a failure never writes into the repo root.
      const result = spawnSync(tsxBin, [entry], {
        cwd: apiDir,
        encoding: 'utf8',
        timeout: 90_000,
        env: { ...process.env, TMPDIR: tmpdir() },
      });
      expect(result.stderr ?? '').not.toContain('sharp is not defined');
      expect(result.status, result.stderr ?? '').toBe(0);
      expect((result.stdout ?? '').trim()).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
