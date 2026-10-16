import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@stackpanel/db';
import type { CatalogEntry, CatalogSnapshot } from '@stackpanel/spec';
import {
  buildUpdatePlan,
  isExcluded,
  normalizeUpdatePolicy,
  pinnedVersionOf,
  policyVersion,
  requiresAuthorization,
  submitUpdateTask,
  readTaskResult,
  listTaskResults,
  withinMaintenanceWindow,
  DEFAULT_UPDATE_POLICY,
} from '../../src/updates/index.ts';
import {
  UPDATE_POLICY_SETTING_KEY,
  readUpdatePolicy,
  saveUpdatePolicy,
} from '../../src/updates/policy.ts';

const REPO = 'worable233/stackpanel-plugins';

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    formatVersion: 1,
    kind: 'plugin',
    id: 'demo',
    version: '1.1.0',
    channel: 'stable',
    source: { repository: REPO, tag: 'demo-v1.1.0', asset: 'demo-1.1.0.zip' },
    artifact: { sha256: 'a'.repeat(64), size: 100 },
    compatibility: {
      kernel: '>=0.2.0 <0.3.0',
      kernelApi: '^0.4.0',
      frontendAbi: '^1.0.0',
      packageFormat: 1,
    },
    requires: [],
    conflicts: [],
    permissions: [],
    frontendModes: ['M2'],
    migration: { mode: 'none', rollback: 'code-compatible' },
    automatic: { eligible: true },
    publisher: 'stackpanel',
    name: 'Demo',
    ...overrides,
  };
}

function catalog(entries: CatalogEntry[]): CatalogSnapshot {
  return {
    formatVersion: 1,
    sequence: 7,
    generatedAt: '2026-10-16T00:00:00.000Z',
    expiresAt: '2026-12-30T00:00:00.000Z',
    channels: [{ channel: 'stable', sequence: 7 }],
    publishers: [{ publisher: 'stackpanel', keyIds: ['pkg-1'], repositories: [REPO] }],
    entries,
  };
}

/** Minimal in-memory prisma stand-in for settings/plugins/themes. */
function fakePrisma(state: {
  settings?: Map<string, unknown>;
  plugins?: Array<{ id: string; enabled: boolean }>;
  themes?: Array<{ id: string; active: boolean }>;
}) {
  const settings = state.settings ?? new Map<string, unknown>();
  return {
    setting: {
      async findUnique({ where }: { where: { key: string } }) {
        return settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null;
      },
      async upsert({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: { value: unknown };
        update: { value: unknown };
      }) {
        settings.set(where.key, settings.has(where.key) ? update.value : create.value);
        return { key: where.key, value: settings.get(where.key) };
      },
    },
    plugin: {
      async findMany() {
        return state.plugins ?? [];
      },
    },
    theme: {
      async findMany() {
        return state.themes ?? [];
      },
    },
  } as unknown as PrismaClient;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-updates-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('update policy', () => {
  it('defaults to conservative (no auto update)', () => {
    expect(normalizeUpdatePolicy(undefined)).toEqual(DEFAULT_UPDATE_POLICY);
  });

  it('normalizes and round-trips through the settings table', async () => {
    const prisma = fakePrisma({});
    expect(await readUpdatePolicy(prisma)).toEqual(DEFAULT_UPDATE_POLICY);
    const saved = await saveUpdatePolicy(
      prisma,
      {
        autoUpdate: true,
        channel: 'beta',
        excluded: ['plugin/demo'],
        pinned: { 'theme/x': '2.0.0' },
      },
      'admin-1',
    );
    expect(saved.autoUpdate).toBe(true);
    expect(saved.channel).toBe('beta');
    expect((await readUpdatePolicy(prisma)).autoUpdate).toBe(true);
  });

  it('computes exclusion / pin / maintenance-window judgements', () => {
    const policy = normalizeUpdatePolicy({
      excluded: ['plugin/demo'],
      pinned: { 'plugin/demo': '1.2.3' },
      maintenanceWindow: { startHour: 2, endHour: 4 },
    });
    expect(isExcluded(policy, 'plugin', 'demo')).toBe(true);
    expect(pinnedVersionOf(policy, 'plugin', 'demo')).toBe('1.2.3');
    expect(withinMaintenanceWindow(policy, new Date('2026-01-01T03:00:00'))).toBe(true);
    expect(withinMaintenanceWindow(policy, new Date('2026-01-01T05:00:00'))).toBe(false);
  });

  it('changes policyVersion when policy changes', () => {
    const a = normalizeUpdatePolicy({ channel: 'stable' });
    const b = normalizeUpdatePolicy({ channel: 'beta' });
    expect(policyVersion(a)).not.toBe(policyVersion(b));
  });
});

describe('buildUpdatePlan', () => {
  it('resolves a plan when the catalog has a compatible newer version', async () => {
    const prisma = fakePrisma({});
    const outcome = await buildUpdatePlan({
      prisma,
      catalog: catalog([entry({ version: '1.1.0' })]),
      policy: normalizeUpdatePolicy({}),
      instanceId: 'sp',
      baselineGeneration: 2,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.packages.map((p) => p.id)).toEqual(['demo']);
    expect(outcome.task.baselineGeneration).toBe(2);
    expect(outcome.task.planDigest).toHaveLength(64);
  });

  it('reports concrete block reasons for an incompatible catalog entry', async () => {
    const prisma = fakePrisma({});
    const outcome = await buildUpdatePlan({
      prisma,
      catalog: catalog([
        entry({
          compatibility: { kernel: '>=9.0.0', kernelApi: '*', frontendAbi: '*', packageFormat: 1 },
        }),
      ]),
      policy: normalizeUpdatePolicy({}),
      instanceId: 'sp',
      baselineGeneration: 0,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.blocks.some((b) => b.code === 'incompatible_kernel')).toBe(true);
  });

  it('flags authorization when a plan adds permissions', async () => {
    const prisma = fakePrisma({});
    const outcome = await buildUpdatePlan({
      prisma,
      catalog: catalog([entry({ permissions: ['orders:write'] })]),
      policy: normalizeUpdatePolicy({}),
      instanceId: 'sp',
      baselineGeneration: 0,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(requiresAuthorization(outcome.plan)).toBe(true);
  });
});

describe('task channel (submit → result)', () => {
  it('submits a task and reads back a result projection', async () => {
    const prisma = fakePrisma({});
    const outcome = await buildUpdatePlan({
      prisma,
      catalog: catalog([entry()]),
      policy: normalizeUpdatePolicy({}),
      instanceId: 'sp',
      baselineGeneration: 0,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    await submitUpdateTask(root, outcome.task);
    const written = JSON.parse(
      await readFile(path.join(root, 'inbox', 'sp', `${outcome.task.idempotencyKey}.json`), 'utf8'),
    ) as { idempotencyKey: string };
    expect(written.idempotencyKey).toBe(outcome.task.idempotencyKey);
    // 未回写时读结果为 null。
    expect(await readTaskResult(root, 'sp', outcome.task.idempotencyKey)).toBeNull();

    const { mkdir, writeFile } = await import('node:fs/promises');
    const resultsDir = path.join(root, 'results', 'sp');
    await mkdir(resultsDir, { recursive: true });
    await writeFile(
      path.join(resultsDir, `${outcome.task.idempotencyKey}.json`),
      JSON.stringify({ phase: 'committed', checkpoints: [] }),
      'utf8',
    );
    const result = await readTaskResult(root, 'sp', outcome.task.idempotencyKey);
    expect(result?.phase).toBe('committed');
    const all = await listTaskResults(root, 'sp');
    expect(all).toHaveLength(1);
  });
});

describe('policy setting key', () => {
  it('uses a stable, namespaced key', () => {
    expect(UPDATE_POLICY_SETTING_KEY).toBe('distribution:update-policy');
  });
});
