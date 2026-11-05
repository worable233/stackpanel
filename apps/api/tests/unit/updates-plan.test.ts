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
      kernel: '>=0.1.0',
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
  /**
   * 内核候选**全部取回/验签失败**时，block detail 必须是真正的原因。
   *
   * 没有这个覆盖时，上游只能拿到通用的 `没有可升级的内核版本` —— 与「已经是最
   * 新」无法区分。真实踩到的场景：数据目录缺 `trust/keyring.json`，界面一直说
   * 「没有可升级的内核版本」，而目录里明明写着 0.1.3。
   */
  it('内核候选全部失败时，把真正原因写进 block detail', async () => {
    const prisma = fakePrisma({});
    const failure =
      '目录声明了内核版本，但全部取回/验签失败 —— 0.1.3（keyId kernel-2026-11）：签名者未被信任';
    const outcome = await buildUpdatePlan({
      prisma,
      catalog: catalog([entry({ version: '1.1.0' })]),
      policy: normalizeUpdatePolicy({}),
      instanceId: 'sp',
      baselineGeneration: 0,
      kernelCandidates: [],
      kernelCandidateFailure: failure,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const block = outcome.blocks.find((b) => b.code === 'incompatible_kernel');
    expect(block, '应当仍报 incompatible_kernel').toBeDefined();
    expect(block?.detail).toBe(failure);
    // 断言不是那句会误导人的通用文案。
    expect(block?.detail).not.toBe('没有可升级的内核版本');
  });

  it('没有提供 kernelCandidateFailure 时保持原样（不改变既有语义）', async () => {
    const prisma = fakePrisma({});
    const outcome = await buildUpdatePlan({
      prisma,
      catalog: catalog([entry({ version: '1.1.0' })]),
      policy: normalizeUpdatePolicy({}),
      instanceId: 'sp',
      baselineGeneration: 0,
      kernelCandidates: [],
    });
    // 扩展更新照常可解 —— 诊断字段缺省不影响求解。
    expect(outcome.ok).toBe(true);
  });

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

  it('solves a kernel self-upgrade from signed kernel candidates (§13-4)', async () => {
    const prisma = fakePrisma({});
    const kernelManifest = {
      formatVersion: 1,
      kind: 'kernel' as const,
      version: '0.3.0',
      channel: 'stable' as const,
      kernelApi: '0.4.0',
      frontendAbi: '1.0.0',
      updateProtocol: 1,
      upgradeFrom: '>=0.1.0',
      migrationPath: 'direct' as const,
      schemaRange: '>=20261001000000',
      images: [
        {
          platform: 'linux/amd64',
          digest: `ghcr.io/worable233/stackpanel@sha256:${'f'.repeat(64)}`,
        },
      ],
      corePackages: [],
      supportedPlatforms: ['linux/amd64'],
      smokeProbeVersion: 1,
      databaseMigration: '20261010000000_kernel_0_3_0',
    };
    const outcome = await buildUpdatePlan({
      prisma,
      catalog: catalog([
        entry({
          version: '1.1.0',
          compatibility: {
            kernel: '>=0.1.0 <0.4.0',
            kernelApi: '^0.4.0',
            frontendAbi: '^1.0.0',
            packageFormat: 1,
          },
        }),
      ]),
      policy: normalizeUpdatePolicy({}),
      instanceId: 'sp',
      baselineGeneration: 0,
      kernelCandidates: [kernelManifest],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.includesKernel).toBe(true);
    expect(outcome.plan.kernel.version).toBe('0.3.0');
    // P0-1：任务与计划里只能是裸 hex，不能是 `repo@sha256:…`。
    expect(outcome.plan.kernel.digest).toBe('f'.repeat(64));
    expect(outcome.task.targetDigest).toBe('f'.repeat(64));
  });

  it('blocks on an incompatible kernel candidate with a concrete reason', async () => {
    const prisma = fakePrisma({});
    const outcome = await buildUpdatePlan({
      prisma,
      catalog: catalog([]),
      policy: normalizeUpdatePolicy({ channel: 'stable' }),
      instanceId: 'sp',
      baselineGeneration: 0,
      kernelCandidates: [
        {
          formatVersion: 1,
          kind: 'kernel' as const,
          version: '0.3.0',
          channel: 'stable' as const,
          kernelApi: '0.4.0',
          frontendAbi: '1.0.0',
          updateProtocol: 2,
          upgradeFrom: '>=0.1.0',
          migrationPath: 'direct' as const,
          schemaRange: '*',
          images: [{ platform: 'linux/amd64', digest: `ghcr.io/x/y@sha256:${'a'.repeat(64)}` }],
          corePackages: [],
          supportedPlatforms: ['linux/amd64'],
          smokeProbeVersion: 1,
          databaseMigration: '20261010000000',
        },
      ],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.blocks[0]?.detail).toContain('升级协议');
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
