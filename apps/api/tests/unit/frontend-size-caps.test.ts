import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { validateFrontendFiles } from '../../src/lib/frontend.ts';

/**
 * Frontend entry / file size caps.
 *
 * A legitimately large compiled entry (the built-in `store` is ~610 KB) must
 * still materialize as a revision instead of falling back to the flat,
 * unversioned path. Source maps are exempt from the per-file cap because they
 * are never parsed or executed, while everything else stays bounded.
 */

const ONE_MB = 1024 * 1024;

function files(entryBytes: number, mapBytes: number, extra: Record<string, number> = {}) {
  const map = new Map<string, Uint8Array>([
    [
      'frontend/manifest.json',
      strToU8(
        JSON.stringify({
          version: '1.0.0',
          revision: '',
          entry: 'frontend/dist/index.js',
          files: ['frontend/dist/index.js', 'frontend/dist/index.js.map', ...Object.keys(extra)],
        }),
      ),
    ],
    ['frontend/dist/index.js', new Uint8Array(entryBytes)],
    ['frontend/dist/index.js.map', new Uint8Array(mapBytes)],
  ]);
  for (const [name, size] of Object.entries(extra)) {
    map.set(name, new Uint8Array(size));
  }
  return map;
}

describe('frontend size caps', () => {
  it('accepts an entry up to 1MB (store-sized bundles get a revision)', () => {
    expect(() => validateFrontendFiles(files(624_139, 10))).not.toThrow();
    expect(() => validateFrontendFiles(files(ONE_MB, 10))).not.toThrow();
  });

  it('rejects an entry above 1MB', () => {
    expect(() => validateFrontendFiles(files(ONE_MB + 1, 10))).toThrow(/前端入口文件过大/);
  });

  it('exempts source maps from the per-file cap (they are never executed)', () => {
    expect(() => validateFrontendFiles(files(624_139, ONE_MB * 2))).not.toThrow();
  });

  it('still caps non-map assets', () => {
    expect(() =>
      validateFrontendFiles(files(1024, 1024, { 'frontend/dist/big.css': ONE_MB + 1 })),
    ).toThrow(/前端文件过大/);
  });
});
