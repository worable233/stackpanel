import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BootstrapStateError,
  BootstrapStateStore,
  candidateConfigPath,
  initialState,
  operationIdFromKey,
  toOperationView,
} from '../../src/bootstrap/state.ts';

const NOW = new Date('2026-10-20T00:00:00.000Z');

async function store(overrides: { targetVersion?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-bootstrap-state-'));
  const instance = new BootstrapStateStore({
    dir,
    now: () => NOW,
    ...(overrides.targetVersion ? { targetVersion: overrides.targetVersion } : {}),
  });
  return { dir, store: instance };
}

describe('BootstrapStateStore', () => {
  it('returns null when no state file exists (never invents one on read)', async () => {
    const { store: s } = await store();
    expect(await s.read()).toBeNull();
  });

  it('publishes a candidate and advances the generation', async () => {
    const { dir, store: s } = await store({ targetVersion: '0.3.0' });
    const published = await s.publishCandidate({
      configContent: 'DATABASE_URL="postgresql://h/db"\n',
      configDigest: 'digest-1',
      idempotencyKey: 'key-1',
    });

    expect(published.phase).toBe('queued');
    expect(published.configGeneration).toBe(1);
    expect(published.targetVersion).toBe('0.3.0');
    expect(published.migrationSucceeded).toBe(false);
    expect(published.runtimeReady).toBe(false);
    expect(published.adminClaimed).toBe(false);

    // The candidate is an immutable file named after the generation.
    const candidate = await readFile(candidateConfigPath(dir, 1), 'utf8');
    expect(candidate).toContain('DATABASE_URL');

    // State is the publication record, referencing that generation.
    const disk = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as {
      configGeneration: number;
      phase: string;
    };
    expect(disk.configGeneration).toBe(1);
    expect(disk.phase).toBe('queued');
  });

  it('replays the same idempotency key and digest without a new generation', async () => {
    const { dir, store: s } = await store();
    const first = await s.publishCandidate({
      configContent: 'A="1"\n',
      configDigest: 'same',
      idempotencyKey: 'key-1',
    });
    const second = await s.publishCandidate({
      configContent: 'A="1"\n',
      configDigest: 'same',
      idempotencyKey: 'key-1',
    });

    expect(second.configGeneration).toBe(first.configGeneration);
    // No second candidate file.
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((n) => n.startsWith('config.candidate-'))).toHaveLength(1);
  });

  it('rejects the same idempotency key with a different config (409 semantics)', async () => {
    const { store: s } = await store();
    await s.publishCandidate({
      configContent: 'A="1"\n',
      configDigest: 'digest-1',
      idempotencyKey: 'key-1',
    });

    await expect(
      s.publishCandidate({
        configContent: 'A="2"\n',
        configDigest: 'digest-2',
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ code: 'generation_mismatch' });
  });

  it('refuses a new config while an operation is in flight', async () => {
    for (const phase of ['validating', 'migrating', 'starting'] as const) {
      const { store: s } = await store();
      await s.write({ ...initialState(NOW), phase });
      await expect(
        s.publishCandidate({
          configContent: 'A="1"\n',
          configDigest: 'd',
          idempotencyKey: 'key-2',
        }),
      ).rejects.toMatchObject({ code: 'not_writable' });
    }
  });

  it('allows a corrected candidate from migration_failed (empty-DB retry path)', async () => {
    const { store: s } = await store();
    await s.write({
      ...initialState(NOW),
      phase: 'migration_failed',
      configGeneration: 1,
      idempotencyKey: 'old',
      configDigest: 'old',
    });
    const next = await s.publishCandidate({
      configContent: 'A="2"\n',
      configDigest: 'new',
      idempotencyKey: 'new-key',
    });
    expect(next.configGeneration).toBe(2);
    expect(next.phase).toBe('queued');
  });

  it('transitions with an expected generation and rejects stale writers', async () => {
    const { store: s } = await store();
    await s.publishCandidate({
      configContent: 'A="1"\n',
      configDigest: 'd',
      idempotencyKey: 'k',
    });

    const migrated = await s.transition(
      { phase: 'migrating' },
      { expectedGeneration: 1 },
    );
    expect(migrated.phase).toBe('migrating');

    await s.transition({ phase: 'starting' }, { expectedGeneration: 1 });

    await expect(
      s.transition({ phase: 'needs_admin' }, { expectedGeneration: 0 }),
    ).rejects.toMatchObject({ code: 'generation_mismatch' });
  });

  it('refuses to transition or corrupt-read into a silent reset', async () => {
    const { dir, store: s } = await store();
    await expect(s.transition({ phase: 'migrating' })).rejects.toBeInstanceOf(BootstrapStateError);

    await writeFile(path.join(dir, 'state.json'), '{"phase":', 'utf8');
    await expect(s.read()).rejects.toMatchObject({ code: 'corrupt_state' });

    await writeFile(path.join(dir, 'state.json'), '{"phase":"queued"}\n', 'utf8');
    await expect(s.read()).rejects.toMatchObject({ code: 'corrupt_state' });
  });

  it('keeps the three completion results independent', async () => {
    const { store: s } = await store();
    await s.publishCandidate({
      configContent: 'A="1"\n',
      configDigest: 'd',
      idempotencyKey: 'k',
    });
    await s.transition({ phase: 'migrating', migrationSucceeded: true });
    const starting = await s.transition({ phase: 'starting', runtimeReady: false });
    expect(starting.migrationSucceeded).toBe(true);
    expect(starting.runtimeReady).toBe(false);
    expect(starting.adminClaimed).toBe(false);

    const ready = await s.transition({ phase: 'needs_admin', runtimeReady: true });
    expect(ready.adminClaimed).toBe(false);
  });
});

describe('toOperationView', () => {
  it('derives an opaque id and never exposes the raw key', () => {
    const state = {
      ...initialState(NOW),
      phase: 'migrating' as const,
      configGeneration: 3,
      targetVersion: '0.3.0',
      failure: 'migration_unknown' as const,
      diagnosticsRequired: true,
    };
    const view = toOperationView(state, 'super-secret-idempotency-key');
    expect(view.id).toBe(operationIdFromKey('super-secret-idempotency-key'));
    expect(view.id).not.toContain('super-secret');
    expect(view.failure).toBe('migration_unknown');
    expect(view.diagnosticsRequired).toBe(true);
    expect(view.configGeneration).toBe(3);
  });
});

describe('operationIdFromKey', () => {
  it('is stable, opaque and bounded', () => {
    expect(operationIdFromKey('k')).toBe(operationIdFromKey('k'));
    expect(operationIdFromKey('k')).not.toBe(operationIdFromKey('k2'));
    expect(operationIdFromKey('k')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('defaultBootstrapStateDir', () => {
  it('is always a bootstrap subdirectory of the state root', async () => {
    const { defaultBootstrapStateDir } = await import('../../src/bootstrap/state.ts');
    expect(defaultBootstrapStateDir('/var/lib/stackpanel')).toBe(
      '/var/lib/stackpanel/bootstrap',
    );
    // Cleanup in case a temp dir leaked.
    await rm(path.join(tmpdir(), 'sp-bootstrap-state-'), { force: true, recursive: true });
  });
});
