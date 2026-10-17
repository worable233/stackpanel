import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runtimeAdminModuleUrl,
  runtimeFrontendEntry,
  runtimeFrontendLoadingEnabled,
} from '@/lib/frontend-runtime';

/**
 * Stage 4 runtime loading — entry resolution (contract 04 §1).
 *
 * The server entry prefers the immutable revision directory (content-addressed),
 * falling back to the flat `dist/` when no revision exists. The admin module URL
 * (M2) mirrors that choice so the browser loads the same deployment version.
 */

const ENV = 'STACKPANEL_DATA_DIR';
let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  delete process.env[ENV];
});

function makeDataDir(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-fe-'));
  process.env[ENV] = dir;
  return dir;
}

describe('runtimeFrontendEntry (stage 4 server entry)', () => {
  it('prefers the immutable revision directory when present', () => {
    const root = makeDataDir();
    const rev = 'abc123def456';
    const versioned = path.join(root, 'themes', 'default', 'frontend', 'revisions', rev, 'dist');
    mkdirSync(versioned, { recursive: true });
    writeFileSync(path.join(versioned, 'index.js'), 'export default {}');
    expect(runtimeFrontendEntry('themes', 'default', rev)).toBe(
      path.join(versioned, 'index.js'),
    );
  });

  it('falls back to the flat dist/ when no revision is given', () => {
    const root = makeDataDir();
    const flat = path.join(root, 'plugins', 'store', 'frontend', 'dist');
    mkdirSync(flat, { recursive: true });
    writeFileSync(path.join(flat, 'index.js'), 'export default {}');
    expect(runtimeFrontendEntry('plugins', 'store')).toBe(path.join(flat, 'index.js'));
  });

  it('returns null when no entry exists', () => {
    makeDataDir();
    expect(runtimeFrontendEntry('plugins', 'missing')).toBeNull();
  });
});

describe('runtimeAdminModuleUrl (stage 4 M2 browser entry)', () => {
  it('targets the versioned admin.runtime.js through the BFF', () => {
    expect(runtimeAdminModuleUrl('plugins', 'store', 'abc123def456')).toBe(
      '/api/plugins/plugins/store/frontend/abc123def456/dist/admin.runtime.js',
    );
  });

  it('falls back to the flat admin.runtime.js without a revision', () => {
    expect(runtimeAdminModuleUrl('plugins', 'store')).toBe(
      '/api/plugins/plugins/store/frontend/dist/admin.runtime.js',
    );
  });
});

describe('runtimeFrontendLoadingEnabled (stage 5 default)', () => {
  const ENV = 'STACKPANEL_FRONTEND_RUNTIME_LOAD';
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('defaults to ON when unset (runtime loading is the default path)', () => {
    delete process.env[ENV];
    expect(runtimeFrontendLoadingEnabled()).toBe(true);
  });

  it('can be explicitly disabled to restore the build-time registry', () => {
    process.env[ENV] = '0';
    expect(runtimeFrontendLoadingEnabled()).toBe(false);
  });

  it('treats any non-"0" value as enabled', () => {
    process.env[ENV] = '1';
    expect(runtimeFrontendLoadingEnabled()).toBe(true);
  });
});
