import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StorageDriver, StorageObjectStat } from '@stackpanel/db';
import {
  activateRevision,
  materializeRevision,
  readCurrentRevision,
  revisionDir,
} from '../../src/lib/frontend-revisions.ts';
import { validateFrontendFiles } from '../../src/lib/frontend.ts';

/**
 * Contract 04 §9 — object-storage local materialization.
 *
 * A revision must exist as a complete local directory (`.ready` last) before it
 * may be activated or imported. These tests use an in-memory `StorageDriver` so
 * the mirror/localize round-trip is exercised without S3.
 */

/** Minimal in-memory driver with the same semantics as the real ones. */
function fakeStorage(): StorageDriver & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    kind: 's3',
    objects,
    async put(key, data) {
      objects.set(key, new Uint8Array(data));
    },
    async get(key) {
      const value = objects.get(key);
      return value ? new Uint8Array(value) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async exists(key) {
      return objects.has(key);
    },
    async stat(key): Promise<StorageObjectStat | null> {
      const value = objects.get(key);
      return value ? { key, size: value.byteLength } : null;
    },
    async list(prefix = '') {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, size: value.byteLength }));
    },
    url(key) {
      return `memory://${key}`;
    },
  };
}

function files(js: string, manifest: Record<string, unknown>): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ['frontend/manifest.json', strToU8(JSON.stringify(manifest))],
    ['frontend/dist/index.js', strToU8(js)],
  ]);
}

const manifest = {
  version: '1.0.0',
  revision: '',
  entry: 'frontend/dist/index.js',
  files: ['frontend/dist/index.js'],
};

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'sp-fe-storage-'));
}

describe('frontend storage mirror (contract 04 §9)', () => {
  it('mirrors a materialized revision and localizes it on another replica', async () => {
    const { publishRevisionToStorage, localizeRevisionFromStorage, isRevisionLocalized } =
      await import('../../src/lib/frontend-storage.ts');
    const storage = fakeStorage();
    const source = await tmp();
    const replica = await tmp();
    try {
      const { revision } = await materializeRevision(source, files('export default 1;', manifest), {
        activate: true,
      });
      const published = await publishRevisionToStorage('plugins', 'demo', revision, source, storage);
      expect(published).toBeGreaterThan(0);
      expect(
        storage.objects.has(`frontend-revisions/plugins/demo/${revision}/dist/index.js`),
      ).toBe(true);
      // The manifest copy is mirrored too, but `.ready` never is: readiness is
      // a per-replica property, not a stored artifact.
      expect(
        [...storage.objects.keys()].some((key) => key.endsWith('/.ready')),
      ).toBe(false);

      expect(isRevisionLocalized(replica, revision)).toBe(false);
      const localized = await localizeRevisionFromStorage(
        'plugins',
        'demo',
        revision,
        replica,
        storage,
      );
      expect(localized?.files).toBeGreaterThan(0);
      expect(isRevisionLocalized(replica, revision)).toBe(true);
      const bytes = await readFile(
        path.join(revisionDir(replica, revision), 'dist', 'index.js'),
        'utf8',
      );
      expect(bytes).toBe('export default 1;');
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(replica, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second mirror does not rewrite existing objects', async () => {
    const { publishRevisionToStorage } = await import('../../src/lib/frontend-storage.ts');
    const storage = fakeStorage();
    const dir = await tmp();
    try {
      const { revision } = await materializeRevision(dir, files('export default 1;', manifest));
      const first = await publishRevisionToStorage('themes', 't', revision, dir, storage);
      const second = await publishRevisionToStorage('themes', 't', revision, dir, storage);
      expect(first).toBeGreaterThan(0);
      expect(second).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the bucket has no such revision', async () => {
    const { localizeRevisionFromStorage } = await import('../../src/lib/frontend-storage.ts');
    const storage = fakeStorage();
    const dir = await tmp();
    try {
      const result = await localizeRevisionFromStorage('themes', 't', '0123456789ab', dir, storage);
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses unsafe revision names and traversal in mirrored keys', async () => {
    const { publishRevisionToStorage, localizeRevisionFromStorage, readRevisionObject } =
      await import('../../src/lib/frontend-storage.ts');
    const storage = fakeStorage();
    const dir = await tmp();
    try {
      expect(await publishRevisionToStorage('themes', 't', '../evil', dir, storage)).toBe(0);
      expect(await localizeRevisionFromStorage('themes', 't', '../evil', dir, storage)).toBeNull();
      expect(await readRevisionObject('themes', 't', '0123456789ab', '../x', storage)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('activation requires a ready revision (contract 04 §4.2)', () => {
  it('rejects activating a revision directory that is not ready', async () => {
    const dir = await tmp();
    try {
      const { revision } = await materializeRevision(dir, files('export default 1;', manifest), {
        activate: false,
      });
      // Simulate a replica that saw the directory but not the completion marker.
      await rm(path.join(revisionDir(dir, revision), '.ready'), { force: true });
      await expect(activateRevision(dir, revision)).rejects.toThrow(/尚未就绪/);
      expect(await readCurrentRevision(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serves a revision from object storage when this replica has not localized it', async () => {
    const { publishRevisionToStorage } = await import('../../src/lib/frontend-storage.ts');
    const { readRevisionObject } = await import('../../src/lib/frontend-storage.ts');
    const storage = fakeStorage();
    const dir = await tmp();
    try {
      const { revision } = await materializeRevision(dir, files('export default 7;', manifest));
      await publishRevisionToStorage('plugins', 'demo', revision, dir, storage);
      // Remove the local copy: a different replica would be in this state.
      await rm(revisionDir(dir, revision), { recursive: true, force: true });
      const bytes = await readRevisionObject(
        'plugins',
        'demo',
        revision,
        'dist/index.js',
        storage,
      );
      expect(bytes && Buffer.from(bytes).toString('utf8')).toBe('export default 7;');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps validateFrontendFiles accepting the mirrored manifest copy', async () => {
    const dir = await tmp();
    try {
      await mkdir(path.join(dir, 'frontend', 'dist'), { recursive: true });
      await writeFile(path.join(dir, 'frontend', 'dist', 'index.js'), 'export default 1;');
      const map = files('export default 1;', manifest);
      expect(validateFrontendFiles(map).entry).toBe('frontend/dist/index.js');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('purgeRevisionStorage 删掉该类该 id 的全部 revision，且不碰别的包', async () => {
    const { publishRevisionToStorage, purgeRevisionStorage } = await import(
      '../../src/lib/frontend-storage.ts'
    );
    const dir = await tmp();
    const storage = fakeStorage();
    try {
      // 两个 revision：模拟升级后旧 revision 仍留在桶里。
      const first = await materializeRevision(dir, files('export default 1;', manifest));
      await publishRevisionToStorage('plugins', 'demo', first.revision, dir, storage);
      await rm(revisionDir(dir, first.revision), { recursive: true, force: true });
      const second = await materializeRevision(dir, files('export default 2;', manifest));
      await publishRevisionToStorage('plugins', 'demo', second.revision, dir, storage);

      // 同前缀但不同包/不同类的对象必须保留。
      await storage.put('frontend-revisions/plugins/demo-extra/rev/dist/index.js', strToU8('x'));
      await storage.put('frontend-revisions/themes/demo/rev/dist/index.js', strToU8('y'));

      const removed = await purgeRevisionStorage('plugins', 'demo', storage);
      expect(removed).toBeGreaterThan(0);
      expect([...storage.objects.keys()].filter((k) => k.startsWith('frontend-revisions/plugins/demo/'))).toEqual([]);
      // `demo-extra` 不以 `plugins/demo/` 为前缀，不能被误删。
      expect(await storage.exists('frontend-revisions/plugins/demo-extra/rev/dist/index.js')).toBe(true);
      expect(await storage.exists('frontend-revisions/themes/demo/rev/dist/index.js')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
