import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Contract 04 §9 — web-replica local materialization.
 *
 * A replica without a shared volume must download a revision before it can
 * `import()` it. `.ready` is written last, so a partial download is never
 * treated as servable. These tests stub `fetch` and point the data dir at a temp
 * root, exercising the real filesystem writes.
 */

const DATA_ENV = 'STACKPANEL_DATA_DIR';
const API_ENV = 'API_BASE_URL';
let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  delete process.env[DATA_ENV];
  delete process.env[API_ENV];
  vi.unstubAllGlobals();
  delete (globalThis as { __STACKPANEL_LOCALIZING__?: unknown }).__STACKPANEL_LOCALIZING__;
});

function makeDataDir(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-web-localize-'));
  process.env[DATA_ENV] = dir;
  process.env[API_ENV] = 'http://kernel.test';
  return dir;
}

function stubKernel(files: Record<string, string>, manifestFiles: string[], failOn?: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      const relative = url.split('/frontend/0123456789ab/')[1] ?? '';
      if (relative === 'manifest.json') {
        return new Response(JSON.stringify({ files: manifestFiles }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (relative === failOn) return new Response('nope', { status: 404 });
      const body = files[relative];
      return body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(body, { status: 200 });
    }),
  );
}

describe('ensureLocalRevision (contract 04 §9)', () => {
  it('downloads every declared file and writes .ready last', async () => {
    const root = makeDataDir();
    stubKernel(
      { 'dist/index.js': 'export default 1;' },
      ['frontend/dist/index.js'],
    );
    const { ensureLocalRevision } = await import('@/lib/frontend-localize');
    const ok = await ensureLocalRevision('plugins', 'demo', '0123456789ab');
    expect(ok).toBe(true);
    const revisionRoot = path.join(root, 'plugins', 'demo', 'frontend', 'revisions', '0123456789ab');
    expect(readFileSync(path.join(revisionRoot, 'dist', 'index.js'), 'utf8')).toBe(
      'export default 1;',
    );
    expect(existsSync(path.join(revisionRoot, '.ready'))).toBe(true);
  });

  it('is a no-op when the revision is already local', async () => {
    const root = makeDataDir();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const revisionRoot = path.join(
      root,
      'themes',
      't',
      'frontend',
      'revisions',
      '0123456789ab',
    );
    mkdirSync(revisionRoot, { recursive: true });
    writeFileSync(path.join(revisionRoot, '.ready'), 'ok\n');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { ensureLocalRevision } = await import('@/lib/frontend-localize');
    expect(await ensureLocalRevision('themes', 't', '0123456789ab')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when a declared file is not servable', async () => {
    const root = makeDataDir();
    stubKernel({ 'dist/index.js': 'x' }, ['frontend/dist/index.js', 'frontend/dist/app.css'], 'dist/app.css');
    const { ensureLocalRevision } = await import('@/lib/frontend-localize');
    expect(await ensureLocalRevision('plugins', 'demo', '0123456789ab')).toBe(false);
    expect(
      existsSync(
        path.join(root, 'plugins', 'demo', 'frontend', 'revisions', '0123456789ab', '.ready'),
      ),
    ).toBe(false);
  });

  it('ignores unsafe declared paths', async () => {
    const root = makeDataDir();
    stubKernel({ 'dist/index.js': 'ok' }, ['../../etc/passwd', 'frontend/dist/index.js']);
    const { ensureLocalRevision } = await import('@/lib/frontend-localize');
    expect(await ensureLocalRevision('plugins', 'demo', '0123456789ab')).toBe(true);
    expect(existsSync(path.join(root, 'plugins', 'demo', 'frontend', 'revisions', '0123456789ab', 'dist', 'index.js'))).toBe(true);
  });

  it('deduplicates concurrent localizations of the same revision', async () => {
    makeDataDir();
    stubKernel({ 'dist/index.js': 'ok' }, ['frontend/dist/index.js']);
    const { ensureLocalRevision } = await import('@/lib/frontend-localize');
    const results = await Promise.all([
      ensureLocalRevision('plugins', 'demo', '0123456789ab'),
      ensureLocalRevision('plugins', 'demo', '0123456789ab'),
    ]);
    expect(results).toEqual([true, true]);
    // manifest + one asset, not twice.
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });
});
