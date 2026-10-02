/**
 * Selective-export domain tests (BACKUP-2 / ADR-0018 §7, gap C4).
 *
 * Covers the domain vocabulary, the table-data exclusion plan and the
 * whole-instance vs. selective decisions. The pg binary is stubbed so this
 * suite stays hermetic.
 */
import { describe, expect, it } from 'vitest';
import type { StorageDriver, StorageObjectStat } from '@stackpanel/db';
import {
  EXPORT_DOMAINS,
  allDomainTables,
  excludeTableDataFor,
  includesObjectStore,
  isExportDomain,
  normalizeDomains,
} from '../../src/backup/domains.ts';
import { createExportArchive, inspectArchive } from '../../src/backup/archive.ts';
import type { PgDumpOptions } from '../../src/backup/pg-tools.ts';

/** In-memory StorageDriver. */
class MemoryStorage implements StorageDriver {
  readonly kind = 'local' as const;
  private readonly objects = new Map<string, Uint8Array>();
  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.objects.set(key, new TextEncoder().encode(value));
    }
  }
  async put(key: string, data: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(data));
  }
  async get(key: string): Promise<Uint8Array | null> {
    const value = this.objects.get(key);
    return value ? new Uint8Array(value) : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async stat(key: string): Promise<StorageObjectStat | null> {
    const value = this.objects.get(key);
    return value ? { key, size: value.byteLength } : null;
  }
  async list(prefix = ''): Promise<StorageObjectStat[]> {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, size: this.objects.get(key)?.byteLength ?? 0 }));
  }
  url(key: string): string {
    return `/storage/${key}`;
  }
}

describe('export domains', () => {
  it('recognises only the declared domains', () => {
    expect(isExportDomain('content')).toBe(true);
    expect(isExportDomain('media')).toBe(true);
    expect(isExportDomain('secrets')).toBe(false);
    expect(isExportDomain('nope')).toBe(false);
  });

  it('normalizes unknown and duplicate domains away, preserving order', () => {
    expect(normalizeDomains(['settings', 'content', 'content', 'bogus'])).toEqual([
      'content',
      'settings',
    ]);
    expect(normalizeDomains(undefined)).toEqual([...EXPORT_DOMAINS]);
    expect(normalizeDomains([])).toEqual([...EXPORT_DOMAINS]);
  });

  it('excludes unselected table data and always excludes secrets by default', () => {
    const excluded = excludeTableDataFor(['content'], false);
    expect(excluded).toContain('payments');
    expect(excluded).toContain('users');
    expect(excluded).toContain('secrets');
    expect(excluded).not.toContain('extension_schema');
    // Extension tables belong to `content`, so they are kept when it is selected.
    expect(excluded).not.toContain('ext_*');

    // Dropping `content` also drops the extension tables' data.
    expect(excludeTableDataFor(['media'], false)).toContain('ext_*');

    const allButSecrets = excludeTableDataFor(EXPORT_DOMAINS, false);
    expect(allButSecrets).toEqual(['secrets']);

    const everything = excludeTableDataFor(EXPORT_DOMAINS, true);
    expect(everything).toEqual([]);
  });

  it('only packs the object store when media is selected', () => {
    expect(includesObjectStore(['media'])).toBe(true);
    expect(includesObjectStore(['content'])).toBe(false);
    expect(includesObjectStore(EXPORT_DOMAINS)).toBe(true);
  });

  it('keeps the domain table map disjoint-ish and non-empty', () => {
    const tables = allDomainTables();
    expect(tables.length).toBeGreaterThan(20);
    expect(new Set(tables).size).toBe(tables.length);
  });
});

describe('selective export archive', () => {
  const stubDump = async (_url: string, out: string, _options: PgDumpOptions): Promise<void> => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(out, 'PGDUMP');
  };

  it('marks a full export as non-selective and includes every domain', async () => {
    const { manifest, mediaCount } = await createExportArchive({
      databaseUrl: 'postgresql://ignored',
      storage: new MemoryStorage({ 'brand/logo.png': 'logo' }),
      appVersion: '0.4.0',
      schemaVersion: 'v1',
      dump: stubDump,
    });
    expect(manifest.selective).toBe(false);
    expect(manifest.includes).toEqual([...EXPORT_DOMAINS]);
    expect(mediaCount).toBe(1);
  });

  it('marks a domain subset selective, skips excluded table data and media', async () => {
    let seen: PgDumpOptions | undefined;
    const storage = new MemoryStorage({ 'brand/logo.png': 'logo' });
    const { manifest, mediaCount } = await createExportArchive({
      databaseUrl: 'postgresql://ignored',
      storage,
      appVersion: '0.4.0',
      schemaVersion: 'v1',
      includes: ['content'],
      dump: async (url, out, options) => {
        seen = options;
        await stubDump(url, out, options);
      },
    });
    expect(manifest.selective).toBe(true);
    expect(manifest.includes).toEqual(['content']);
    // The object store is not walked because `media` is not selected.
    expect(mediaCount).toBe(0);
    expect(seen?.excludeTableData).toContain('payments');
    expect(seen?.excludeTableData).toContain('secrets');
    expect(seen?.excludeTableData).not.toContain('ext_*');
  });

  it('records secretsIncluded and stops excluding the secrets table', async () => {
    let seen: PgDumpOptions | undefined;
    const { manifest } = await createExportArchive({
      databaseUrl: 'postgresql://ignored',
      storage: new MemoryStorage(),
      appVersion: '0.4.0',
      schemaVersion: 'v1',
      includes: ['settings'],
      secretsIncluded: true,
      dump: async (url, out, options) => {
        seen = options;
        await stubDump(url, out, options);
      },
    });
    expect(manifest.secretsIncluded).toBe(true);
    expect(seen?.excludeTableData).not.toContain('secrets');
    expect(seen?.excludeTableData).toContain('payments');
  });

  it('round-trips the selective/secret flags through inspect', async () => {
    const { archive } = await createExportArchive({
      databaseUrl: 'postgresql://ignored',
      storage: new MemoryStorage(),
      appVersion: '0.4.0',
      schemaVersion: 'v1',
      includes: ['settings'],
      secretsIncluded: true,
      dump: async (_url, out) => {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(out, 'PGDUMP');
      },
    });
    const inspected = inspectArchive(archive);
    expect(inspected.manifest.secretsIncluded).toBe(true);
    expect(inspected.manifest.selective).toBe(true);
    expect(inspected.manifest.includes).toEqual(['settings']);
  });
});
