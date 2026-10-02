/**
 * Export/import archive tests (BACKUP / ADR-0018).
 *
 * Covers the format primitives (USTAR round-trip, manifest/checksum validation)
 * and the end-to-end archive lifecycle with the pg binaries stubbed out, so the
 * suite is hermetic and needs no `pg_dump` on the machine.
 */
import { describe, expect, it } from 'vitest';
import type { StorageDriver, StorageObjectStat } from '@stackpanel/db';
import { createTar, extractTar, TarFormatError } from '../../src/backup/tar.ts';
import {
  compareVersions,
  createExportArchive,
  inspectArchive,
  importExportArchive,
} from '../../src/backup/archive.ts';
import { ExportValidationError, renderChecksums, parseChecksums } from '../../src/backup/manifest.ts';
import {
  enterMaintenance,
  exitMaintenance,
  isMaintenanceMode,
} from '../../src/backup/service.ts';
import { maintenanceWriteGuard } from '../../src/backup/guard.ts';
import { getBackupStatus, resetBackupStatus } from '../../src/backup/control.ts';
import { getStateService } from '../../src/state/index.ts';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** In-memory StorageDriver for tests. */
class MemoryStorage implements StorageDriver {
  readonly kind = 'local' as const;
  private readonly objects = new Map<string, Uint8Array>();
  private clock = 0;

  async put(key: string, data: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(data));
    this.clock += 1;
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
    if (!value) return null;
    this.clock += 1;
    return { key, size: value.byteLength, lastModified: new Date(this.clock).toISOString() };
  }
  async list(prefix = ''): Promise<StorageObjectStat[]> {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, size: this.objects.get(key)?.byteLength ?? 0 }));
  }
  url(key: string): string {
    return `/storage/${key}`;
  }
  /** Test helper: current keys. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('USTAR codec', () => {
  it('round-trips regular files and ignores directory entries', () => {
    const archive = createTar([
      { name: 'brand/logo.png', data: encoder.encode('PNG') },
      { name: 'docs/readme.txt', data: encoder.encode('hello world') },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ]);
    const files = extractTar(archive);
    expect([...files.keys()].sort()).toEqual(['brand/logo.png', 'docs/readme.txt', 'empty.txt']);
    expect(decoder.decode(files.get('brand/logo.png'))).toBe('PNG');
    expect(decoder.decode(files.get('docs/readme.txt'))).toBe('hello world');
    expect(files.get('empty.txt')?.byteLength).toBe(0);
  });

  it('aligns payloads to 512-byte blocks', () => {
    const archive = createTar([{ name: 'a.bin', data: new Uint8Array(600) }]);
    // 1 header block + 600 bytes rounded to 1024 + two zero end blocks.
    expect(archive.byteLength).toBe(512 + 1024 + 1024);
  });

  it('rejects an over-long path', () => {
    const name = `${'x'.repeat(160)}/${'y'.repeat(120)}`;
    expect(() => createTar([{ name, data: new Uint8Array(0) }])).toThrow(TarFormatError);
  });

  it('throws on a truncated payload', () => {
    const archive = createTar([{ name: 'big', data: new Uint8Array(2000) }]);
    const truncated = archive.slice(0, 900);
    expect(() => extractTar(truncated)).toThrow(TarFormatError);
  });
});

describe('checksums file', () => {
  it('round-trips the coreutils format', () => {
    const text = renderChecksums({ 'a.bin': 'a'.repeat(64), 'b.bin': 'b'.repeat(64) });
    expect(parseChecksums(text)).toEqual({ 'a.bin': 'a'.repeat(64), 'b.bin': 'b'.repeat(64) });
  });
});

describe('compareVersions', () => {
  it('orders numeric segments and treats missing parts as zero', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('20261001000000', '20260930000000')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
  });
});

describe('export/import archive', () => {
  const stubDump = async (_url: string, out: string): Promise<void> => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(out, 'PGDUMP-CONTENT');
  };

  it('builds an archive with manifest, media and checksums', async () => {
    const storage = new MemoryStorage();
    await storage.put('brand/logo.png', encoder.encode('logo-bytes'));
    await storage.put('uploads/a.txt', encoder.encode('attachment'));

    const { archive, manifest, mediaCount } = await createExportArchive({
      databaseUrl: 'postgresql://ignored',
      storage,
      appVersion: '0.4.0',
      schemaVersion: '20261001000000_api_token_usage',
      dump: stubDump,
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    });

    expect(mediaCount).toBe(2);
    expect(manifest.engine).toBe('postgresql');
    expect(manifest.exportedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(Object.keys(manifest.checksums).sort()).toEqual(['database.dump', 'media.tar']);

    const inspected = inspectArchive(archive);
    expect(inspected.manifest.appVersion).toBe('0.4.0');
    expect(inspected.mediaCount).toBe(2);
    const media = extractTar(inspected.mediaTar);
    expect(decoder.decode(media.get('brand/logo.png'))).toBe('logo-bytes');
    expect(decoder.decode(media.get('uploads/a.txt'))).toBe('attachment');
  });

  it('rejects a corrupted archive before restoring', async () => {
    const storage = new MemoryStorage();
    const { archive } = await createExportArchive({
      databaseUrl: 'postgresql://ignored',
      storage,
      appVersion: '0.4.0',
      schemaVersion: 'v1',
      dump: stubDump,
    });
    // Tamper the dump bytes and recompress: the gzip/tar are structurally
    // valid, so only the SHA-256 check can catch it.
    const { gunzipSync, gzipSync } = await import('fflate');
    const tarBytes = gunzipSync(archive);
    const files = extractTar(tarBytes);
    const dump = files.get('database.dump');
    if (!dump) throw new Error('test setup: missing database.dump');
    dump[0] = (dump[0] ?? 0) ^ 0xff;
    const tampered = gzipSync(createTar([...files].map(([name, data]) => ({ name, data }))));
    expect(() => inspectArchive(tampered)).toThrow(ExportValidationError);

    let restoreCalled = false;
    await expect(
      importExportArchive({
        archive: tampered,
        databaseUrl: 'postgresql://ignored',
        storage,
        currentSchemaVersion: 'v1',
        restore: async () => {
          restoreCalled = true;
        },
      }),
    ).rejects.toThrow();
    expect(restoreCalled).toBe(false);
  });

  it('refuses an archive from a newer schema', async () => {
    const storage = new MemoryStorage();
    const { archive } = await createExportArchive({
      databaseUrl: 'postgresql://ignored',
      storage,
      appVersion: '0.4.0',
      schemaVersion: '20270101000000_future',
      dump: stubDump,
    });
    await expect(
      importExportArchive({
        archive,
        databaseUrl: 'postgresql://ignored',
        storage,
        currentSchemaVersion: '20261001000000_api_token_usage',
        restore: async () => undefined,
      }),
    ).rejects.toThrow(ExportValidationError);
  });

  it('restores media and calls the pre-restore hook', async () => {
    const source = new MemoryStorage();
    await source.put('brand/logo.png', encoder.encode('logo-bytes'));
    const { archive } = await createExportArchive({
      databaseUrl: 'postgresql://ignored',
      storage: source,
      appVersion: '0.4.0',
      schemaVersion: 'v1',
      dump: stubDump,
    });

    const target = new MemoryStorage();
    let hookCalled = false;
    let restorePath = '';
    const result = await importExportArchive({
      archive,
      databaseUrl: 'postgresql://ignored',
      storage: target,
      currentSchemaVersion: 'v1',
      beforeRestore: async () => {
        hookCalled = true;
      },
      restore: async (_url, path) => {
        restorePath = path;
      },
    });
    expect(hookCalled).toBe(true);
    expect(restorePath.endsWith('database.dump')).toBe(true);
    expect(result.mediaCount).toBe(1);
    expect(target.keys()).toEqual(['brand/logo.png']);
    expect(decoder.decode(await target.get('brand/logo.png'))).toBe('logo-bytes');
  });
});

/** Minimal Fastify request/reply stand-ins for exercising the guard directly. */
function fakeRequest(method: string, url: string): FastifyRequest {
  return { method, url, id: 'req-test' } as unknown as FastifyRequest;
}
function fakeReply(): {
  reply: FastifyReply;
  captured: { status: number; headers: Record<string, string>; body: unknown };
} {
  const captured = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
  const reply = {
    code(status: number) {
      captured.status = status;
      return reply;
    },
    header(key: string, value: string) {
      captured.headers[key.toLowerCase()] = value;
      return reply;
    },
    send(body: unknown) {
      captured.body = body;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, captured };
}

describe('maintenance mode', () => {
  it('blocks writes until exited and expires on its own', async () => {
    await exitMaintenance();
    expect(await isMaintenanceMode()).toBeNull();
    await enterMaintenance('导入测试', 1000);
    expect((await isMaintenanceMode())?.reason).toBe('导入测试');
    await exitMaintenance();
    expect(await isMaintenanceMode()).toBeNull();

    // TTL lapse: a short window expires without an explicit exit.
    await enterMaintenance('短暂', 20);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await isMaintenanceMode()).toBeNull();
  });

  it('stores the flag in the shared state, so every replica observes it', async () => {
    await exitMaintenance();
    await enterMaintenance('共享', 1000);
    // The flag is a shared-state key (Redis in a cluster), not process memory.
    const raw = await getStateService().get('backup:maintenance');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).reason).toBe('共享');
    await exitMaintenance();
    expect(await getStateService().get('backup:maintenance')).toBeNull();
  });

  it('guard 503s mutating writes on the shared flag, lets reads/allowlist through', async () => {
    await exitMaintenance();
    const pass = fakeReply();
    await maintenanceWriteGuard(fakeRequest('PATCH', '/admin/settings'), pass.reply);
    expect(pass.captured.status).toBe(0);

    await enterMaintenance('导入中', 5000);
    const blocked = fakeReply();
    await maintenanceWriteGuard(fakeRequest('POST', '/admin/settings'), blocked.reply);
    expect(blocked.captured.status).toBe(503);
    expect(blocked.captured.headers['retry-after']).toBe('60');
    expect((blocked.captured.body as { code?: string }).code).toBe('backup.maintenance');

    // Reads and the control/health allowlist stay reachable.
    const read = fakeReply();
    await maintenanceWriteGuard(fakeRequest('GET', '/admin/settings'), read.reply);
    expect(read.captured.status).toBe(0);
    const control = fakeReply();
    await maintenanceWriteGuard(fakeRequest('POST', '/admin/backup/import'), control.reply);
    expect(control.captured.status).toBe(0);

    await exitMaintenance();
  });
});

describe('backup control plane', () => {
  it('reconciles an abandoned running job so the cluster is not wedged', async () => {
    await resetBackupStatus();
    await getStateService().set(
      'backup:status',
      JSON.stringify({
        state: 'running',
        action: 'import',
        requestedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        runExpiresAt: new Date(Date.now() - 1000).toISOString(),
        detail: null,
        error: null,
        result: null,
      }),
      60_000,
    );
    const status = await getBackupStatus();
    expect(status.state).toBe('failed');
    expect(status.error).toContain('超时');
    await resetBackupStatus();
  });
});
