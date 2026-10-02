/**
 * Build a built-in plugin package into a single runnable ESM bundle.
 *
 * Plugins are consumed by the API kernel at runtime: the boot seed copies a
 * plugin's `dist/` into `data/plugins/<id>/`, then the kernel imports its entry
 * (`dist/index.js`) with Node's native ESM loader.
 *
 * A plain `tsc` emit is NOT sufficient here: with the shared
 * `moduleResolution: "bundler"` the emitted JS keeps bare relative imports
 * (e.g. `./errors` without a `.js` suffix), which Node ESM cannot resolve. We
 * therefore bundle every plugin's source into a single `dist/index.js` so the
 * output is always runnable regardless of how individual sources write their
 * relative imports. Bare package imports (`@stackpanel/*`, `@prisma/*`, …) are
 * left external and resolved at runtime from the workspace root `node_modules`,
 * matching how the kernel already loads plugin packages.
 *
 * Usage (run from a plugin package dir):
 *   node ../../scripts/build-plugin.mjs
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const cwd = process.cwd();
const srcEntry = resolve(cwd, 'src/index.ts');
const distDir = resolve(cwd, 'dist');

if (!existsSync(srcEntry)) {
  console.error(`[build-plugin] no entry at ${srcEntry}`);
  process.exit(1);
}

// 1) Emit type declarations into dist (mirrors the shared `declaration: true`).
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
execSync('tsc -p tsconfig.build.json --emitDeclarationOnly', {
  cwd,
  stdio: 'inherit',
});

// 2) Bundle the runtime entry into a single runnable ESM file.
await build({
  entryPoints: [srcEntry],
  outfile: resolve(distDir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  packages: 'external',
  logLevel: 'info',
});

console.log(`[build-plugin] bundled ${srcEntry} -> ${resolve(distDir, 'index.js')}`);
