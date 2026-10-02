/**
 * Admin export/import endpoint tests (BACKUP / ADR-0018).
 *
 * The pg binaries are stubbed at the tool-detection seam, and the job executor
 * is captured instead of enqueuing, so these tests exercise the HTTP contract
 * (auth, validation, maintenance, status) without a real worker or pg_dump.
 */
import type { FastifyInstance } from 'fastify';
import type { StorageDriver, StorageObjectStat } from '@stackpanel/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getStorage } from '../../src/infra.ts';
import { createExportArchive } from '../../src/backup/archive.ts';
import { setPgToolsOverride } from '../../src/backup/pg-tools.ts';
import {
  resetBackupStatus,
  setBackupExecutor,
  type BackupAction,
} from '../../src/backup/control.ts';
import {
  enterMaintenance,
  exitMaintenance,
  isMaintenanceMode,
} from '../../src/backup/service.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();
const encoder = new TextEncoder();

class MemoryStorage implements StorageDriver {
  readonly kind = 'local' as const;
  private readonly objects = new Map<string, Uint8Array>();
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

/** Build a valid archive completely in memory (pg_dump stubbed). */
async function makeArchive(): Promise<Uint8Array> {
  const storage = new MemoryStorage();
  await storage.put('brand/logo.png', encoder.encode('logo'));
  const { archive } = await createExportArchive({
    databaseUrl: 'postgresql://ignored',
    storage,
    appVersion: '0.4.0',
    schemaVersion: '20261001000000_api_token_usage',
    dump: async (_url, out) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(out, 'PGDUMP');
    },
  });
  return archive;
}

describe.skipIf(!dbAvailable)('admin backup endpoints (real DB)', () => {
  let app: FastifyInstance;
  let adminToken = '';
  let userToken = '';
  const calls: Array<{ action: BackupAction; payload: Record<string, unknown> }> = [];
  const suffix = Date.now();

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(app, `backup_admin_${suffix}@example.com`);
    const user = await createTestUser(app, `backup_user_${suffix}@example.com`);
    adminToken = admin.token;
    userToken = user.token;
  });

  afterAll(async () => {
    setPgToolsOverride(null);
    setBackupExecutor(null);
    await resetBackupStatus();
    await exitMaintenance();
    await app.close();
  });

  beforeEach(async () => {
    calls.length = 0;
    await resetBackupStatus();
    await exitMaintenance();
    setPgToolsOverride({ pgDump: '/usr/bin/pg_dump', pgRestore: '/usr/bin/pg_restore', available: true });
    setBackupExecutor(async (action, payload) => {
      calls.push({ action, payload });
    });
  });

  it('reports status and tool availability to admins only', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/admin/backup' });
    expect(anonymous.statusCode).toBe(401);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/admin/backup',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'GET',
      url: '/admin/backup',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { status: { state: string }; tools: { available: boolean } };
    expect(body.status.state).toBe('idle');
    expect(body.tools.available).toBe(true);
  });

  it('queues an export and refuses a concurrent second request', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/admin/backup/export',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(first.statusCode).toBe(202);
    expect(calls.map((c) => c.action)).toEqual(['export']);

    const second = await app.inject({
      method: 'POST',
      url: '/admin/backup/export',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(second.statusCode).toBe(409);
  });

  it('exposes selective-export domains, secret availability and the DB location', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/backup',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      domains: string[];
      secretsAvailable: boolean;
      database: { database: string } | null;
    };
    expect(body.domains).toContain('content');
    expect(body.domains).toContain('media');
    // The test env sets SETTINGS_ENCRYPTION_KEY, so secrets are exportable.
    expect(body.secretsAvailable).toBe(true);
    // The database location must never leak credentials.
    expect(JSON.stringify(body.database)).not.toContain('stackpanel:stackpanel');
  });

  it('queues a selective export with the requested domains (C4)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/backup/export',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { includes: ['content', 'users'] },
    });
    expect(res.statusCode).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload['includes']).toEqual(['content', 'users']);
  });

  it('rejects an export with an unknown domain', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/backup/export',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { includes: ['content', 'not-a-domain'] },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('accepts includeSecrets only when the instance key is configured (C6)', async () => {
    // With SETTINGS_ENCRYPTION_KEY present in the test env this is allowed and
    // passed through to the job; the guard against a missing key is unit-tested
    // in runExportJob, here we assert the request never silently drops the flag.
    const res = await app.inject({
      method: 'POST',
      url: '/admin/backup/export',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { includeSecrets: true },
    });
    expect(res.statusCode).toBe(202);
    expect(calls[0]?.payload['includeSecrets']).toBe(true);
  });

  it('returns 501 when pg tools are unavailable', async () => {
    setPgToolsOverride({ pgDump: null, pgRestore: null, available: false });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/backup/export',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(501);
    expect(calls).toHaveLength(0);
  });

  it('requires explicit confirmation to import', async () => {
    const archive = await makeArchive();
    const archiveBase64 = Buffer.from(archive).toString('base64');

    const missingConfirm = await app.inject({
      method: 'POST',
      url: '/admin/backup/import',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { archiveBase64 },
    });
    expect(missingConfirm.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/admin/backup/import',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { archiveBase64, confirm: true },
    });
    expect(ok.statusCode).toBe(202);
    expect(calls.map((c) => c.action)).toEqual(['import']);
    // Maintenance is entered at request time in the shared state, so every
    // replica's write-guard sees it before the job is even picked up.
    expect((await isMaintenanceMode())?.reason).toBe('实例导入进行中');
  });

  it('rejects a corrupt archive with 422 and never queues a job', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/backup/import',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { archiveBase64: Buffer.from('not-a-gzip').toString('base64'), confirm: true },
    });
    expect(res.statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('inspects an archive without importing', async () => {
    const archive = await makeArchive();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/backup/inspect',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { archiveBase64: Buffer.from(archive).toString('base64') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { manifest: { appVersion: string; engine: string }; mediaCount: number };
    expect(body.manifest.appVersion).toBe('0.4.0');
    expect(body.manifest.engine).toBe('postgresql');
    expect(body.mediaCount).toBe(1);
  });

  it('streams a stored archive for download', async () => {
    const key = `backups/test-${suffix}.tar.gz`;
    await getStorage().put(key, encoder.encode('archive-bytes'));
    const res = await app.inject({
      method: 'GET',
      url: `/admin/backup/download?key=${encodeURIComponent(key)}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.rawPayload.toString()).toBe('archive-bytes');
    await getStorage().delete(key);
  });

  it('rejects writes while an import holds maintenance mode', async () => {
    await enterMaintenance('导入中', 10_000);
    // A representative mutating admin endpoint (settings) must be refused.
    const blocked = await app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { key: 'x', value: 'y' },
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.headers['retry-after']).toBe('60');

    // The control plane itself stays reachable.
    const status = await app.inject({
      method: 'GET',
      url: '/admin/backup',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(status.statusCode).toBe(200);
    expect((status.json() as { maintenance: boolean }).maintenance).toBe(true);

    await exitMaintenance();
  });
});
