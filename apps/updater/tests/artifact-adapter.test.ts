/**
 * 产物载体测试：不碰 Docker / PM2 / 网络，用假命令执行器与本地 HTTP 服务器覆盖
 * 下载校验、解包安全、原子切换、迁移顺序、回滚与状态机推进（ADR-0025）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateTask } from '@stackpanel/spec';
import type { CommandRequest, CommandResult, CommandRunner } from '../src/command.ts';
import { UpdateEngine } from '../src/engine.ts';
import { FileUpdateJournal } from '../src/journal.ts';
import { ExecutorLock } from '../src/executor-lock.ts';
import { FileDeploymentPointer } from '../src/deployment-pointer.ts';
import {
  ArtifactDeploymentAdapter,
  assertHttpsUrl,
  assertSafeArchivePath,
  parseDfFreeBytes,
} from '../src/artifact/adapter.ts';
import { resolveLayout } from '../src/artifact/layout.ts';
import { parseRunnerArgs } from '../src/artifact/main.ts';

const VERSION = '0.3.0';

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 假 tar：`-tf` 返回条目列表，`-xf` 把预置文件写进目标目录。 */
function fakeTarRunner(files: Record<string, Record<string, string>>) {
  const calls: CommandRequest[] = [];
  const pendingDir = new Map<string, string>();
  const runner: CommandRunner = {
    async run(req): Promise<CommandResult> {
      calls.push(req);
      if (req.file === 'tar' && req.args.includes('-tf')) {
        const archive = req.args[req.args.indexOf('-tf') + 1] ?? '';
        return {
          code: 0,
          stdout: Object.keys(files[path.basename(archive)] ?? {}).join('\n') + '\n',
          stderr: '',
        };
      }
      if (req.file === 'tar' && req.args.includes('-xf')) {
        const archive = req.args[req.args.indexOf('-xf') + 1] ?? '';
        const dir = req.args[req.args.indexOf('-C') + 1] ?? '';
        for (const [name, content] of Object.entries(files[path.basename(archive)] ?? {})) {
          const target = path.join(dir, name);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content);
        }
        pendingDir.set(path.basename(archive), dir);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { runner, calls };
}

function releaseJson(role: 'kernel' | 'migrate', version = VERSION): string {
  return JSON.stringify({
    formatVersion: 1,
    kind: 'kernel-artifact',
    role,
    version,
    platform: 'linux/amd64',
    nodeMajor: Number(process.versions.node.split('.')[0]),
    kernelApi: '0.4.0',
    frontendAbi: '1.0.0',
    updateProtocol: 1,
    databaseMigration: '20261010',
  });
}

function task(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    protocolVersion: 1,
    instanceId: 'sp',
    baselineGeneration: 0,
    targetDigest: 'a'.repeat(64),
    planDigest: 'plan',
    idempotencyKey: 'k1',
    policyVersion: 1,
    plan: {
      kernel: {
        version: VERSION,
        digest: 'a'.repeat(64),
        migration: '20261010',
        carrier: 'artifact',
        url: 'https://example.test/kernel.tar.zst',
        size: 10,
        migrationArtifact: {
          url: 'https://example.test/migrate.tar.zst',
          sha256: 'b'.repeat(64),
          size: 20,
          nodeMajor: Number(process.versions.node.split('.')[0]),
        },
      },
      packages: [],
      planDigestInput: { kernelVersion: VERSION, packages: [], frontendAbi: '1', schemaRange: '*' },
    },
    createdAt: '2026-10-18T00:00:00Z',
    ...overrides,
  };
}

let root: string;
let layout: ReturnType<typeof resolveLayout>;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-artifact-'));
  layout = resolveLayout({
    root: path.join(root, 'opt'),
    stateDir: path.join(root, 'state'),
    instanceId: 'sp',
  });
  server = createServer((req, res) => {
    if (req.url === '/kernel.tar.zst') {
      res.end('kernel-archive');
      return;
    }
    if (req.url === '/migrate.tar.zst') {
      res.end('migrate-archive');
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  });
  for (const dir of [
    layout.releasesDir,
    layout.stagingDir,
    layout.workDir,
    layout.downloadsDir,
    layout.backupsDir,
    layout.updateDir,
  ]) {
    await mkdir(dir, { recursive: true });
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

/** 下载用的是 https 校验；测试里把 URL 换成本地 http 并只放宽该函数。 */
function localTask(): UpdateTask {
  const base = task();
  return {
    ...base,
    targetDigest: sha('kernel-archive'),
    plan: {
      ...base.plan,
      kernel: {
        ...base.plan.kernel,
        digest: sha('kernel-archive'),
        url: `${baseUrl}/kernel.tar.zst`,
        size: 'kernel-archive'.length,
        migrationArtifact: {
          url: `${baseUrl}/migrate.tar.zst`,
          sha256: sha('migrate-archive'),
          size: 'migrate-archive'.length,
          nodeMajor: Number(process.versions.node.split('.')[0]),
        },
      },
    },
  };
}

function adapterFor(runner: CommandRunner, options: { probes?: boolean } = {}) {
  return new ArtifactDeploymentAdapter({
    layout,
    runner,
    probes: {
      healthUrl: `${baseUrl}/kernel.tar.zst`,
      readinessUrl: `${baseUrl}/kernel.tar.zst`,
      webUrl: `${baseUrl}/kernel.tar.zst`,
    },
    probe: options.probes === false ? async () => false : async () => true,
    databaseBackup: false,
    databaseUrl: 'postgresql://test/test',
    verifyTimeoutMs: 50,
    verifyPollMs: 10,
    // 测试用本地 http 服务器；生产适配器只允许 https。
    assertUrl: () => undefined,
  });
}

describe('archive safety', () => {
  it('rejects absolute paths and parent traversal', () => {
    expect(() => assertSafeArchivePath('/etc/passwd')).toThrow(/绝对路径/);
    expect(() => assertSafeArchivePath('C:/Windows')).toThrow(/绝对路径/);
    expect(() => assertSafeArchivePath('apps/../../etc/x')).toThrow(/逃出/);
  });

  it('only accepts https download URLs', () => {
    expect(() => assertHttpsUrl('http://example.com/a')).toThrow(/https/);
    expect(() => assertHttpsUrl('file:///etc/passwd')).toThrow(/https/);
    expect(() => assertHttpsUrl('https://example.com/a')).not.toThrow();
  });

  it('parses df free bytes', () => {
    expect(
      parseDfFreeBytes(
        'Filesystem 1024-blocks Used Available Capacity Mounted\nx 100 50 50 50% /\n',
      ),
    ).toBe(50 * 1024);
  });

  it('parses CLI modes', () => {
    expect(parseRunnerArgs([])).toEqual({ mode: 'drain' });
    expect(parseRunnerArgs(['--rollback'])).toEqual({ mode: 'rollback' });
    expect(parseRunnerArgs(['--requeue'])).toEqual({ mode: 'requeue' });
    expect(parseRunnerArgs(['--request', '/tmp/t.json'])).toEqual({
      mode: 'request',
      requestFile: '/tmp/t.json',
    });
    expect(() => parseRunnerArgs(['--nope'])).toThrow(/未知参数/);
  });
});

describe('artifact adapter', () => {
  it('downloads, verifies digests and stages both packs', async () => {
    const { runner, calls } = fakeTarRunner({
      'kernel.tar.zst': { 'RELEASE.json': releaseJson('kernel') },
      'migrate.tar.zst': {
        'RELEASE.json': releaseJson('migrate'),
        'migrate.mjs': 'process.exit(0)',
      },
    });
    const adapter = adapterFor(runner);
    const result = await adapter.download({
      task: localTask(),
      targetDigest: sha('kernel-archive'),
      planDigest: 'p',
      workDir: layout.workDir,
    });
    expect(result.credential).toContain(sha('kernel-archive'));
    expect(result.credential).toContain(sha('migrate-archive'));
    expect(calls.some((call) => call.args.includes('-tf'))).toBe(true);
  });

  it('rejects a corrupt kernel download without leaving the final file', async () => {
    const { runner } = fakeTarRunner({});
    const adapter = adapterFor(runner);
    const bad = localTask();
    bad.plan.kernel.digest = 'c'.repeat(64);
    bad.targetDigest = 'c'.repeat(64);
    await expect(
      adapter.download({
        task: bad,
        targetDigest: bad.targetDigest,
        planDigest: 'p',
        workDir: layout.workDir,
      }),
    ).rejects.toThrow(/sha256 不匹配/);
  });

  it('stops after quiescing all three PM2 apps and never restarts the worker early', async () => {
    const { runner, calls } = fakeTarRunner({});
    const adapter = adapterFor(runner);
    await adapter.quiesce({
      task: localTask(),
      targetDigest: '',
      planDigest: 'p',
      workDir: layout.workDir,
    });
    const stop = calls.find((call) => call.args.includes('stop'));
    expect(stop?.args).toEqual(
      expect.arrayContaining(['stackpanel-api', 'stackpanel-worker', 'stackpanel-web']),
    );
    expect(calls.some((call) => call.args.includes('save'))).toBe(true);
  });

  it('refuses preflight when the baseline generation moved', async () => {
    const { runner } = fakeTarRunner({});
    const adapter = adapterFor(runner);
    await FileDeploymentPointer.resolve(layout.updateDir).write({
      generation: 7,
      digest: 'd'.repeat(64),
      previousDigest: null,
      previousGeneration: null,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    await expect(
      adapter.preflight({
        task: localTask(),
        targetDigest: '',
        planDigest: 'p',
        workDir: layout.workDir,
      }),
    ).rejects.toThrow(/基线代次/);
  });

  it('runs the engine end to end and switches current atomically', async () => {
    const { runner, calls } = fakeTarRunner({
      'kernel.tar.zst': { 'RELEASE.json': releaseJson('kernel') },
      'migrate.tar.zst': {
        'RELEASE.json': releaseJson('migrate'),
        'migrate.mjs': 'process.exit(0)',
      },
    });
    const adapter = adapterFor(runner);
    await mkdir(layout.releasesDir, { recursive: true });
    const previous = path.join(layout.releasesDir, '0.2.0');
    await mkdir(previous, { recursive: true });
    await symlink(previous, layout.currentLink);

    const journal = new FileUpdateJournal(layout.journalFile);
    const engine = new UpdateEngine({
      adapter,
      journal,
      lock: new ExecutorLock({ filePath: layout.lockFile, owner: 'test' }),
      workDir: layout.workDir,
    });
    const result = await engine.run(localTask(), true);
    expect(result, JSON.stringify(result)).toMatchObject({ phase: 'committed' });

    const now = await readlink(layout.currentLink);
    expect(now).toBe(path.join(layout.releasesDir, VERSION));
    expect((await FileDeploymentPointer.resolve(layout.updateDir).read())?.digest).toBe(
      sha('kernel-archive'),
    );
    // 迁移必须在停服之后、PM2 start 之前。
    const migrateIndex = calls.findIndex((call) =>
      call.args.some((arg) => arg.endsWith('migrate.mjs')),
    );
    const startIndex = calls.findIndex((call) => call.args.includes('start'));
    expect(migrateIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(migrateIndex);
  });

  it('rolls back to the pre-switch release when probes fail on the first upgrade', async () => {
    // 场景：初始安装只有一个 release（即当前版本）。回退必须回到它，而不是因为
    // 「releases 里排除 current 后为空」而放弃（P0：首次升级失败会卡在维护态）。
    const { runner } = fakeTarRunner({
      'kernel.tar.zst': { 'RELEASE.json': releaseJson('kernel') },
      'migrate.tar.zst': {
        'RELEASE.json': releaseJson('migrate'),
        'migrate.mjs': 'process.exit(0)',
      },
    });
    const previous = path.join(layout.releasesDir, '0.2.0');
    await mkdir(previous, { recursive: true });
    await writeFile(path.join(previous, 'RELEASE.json'), releaseJson('kernel', '0.2.0'));
    await symlink(previous, layout.currentLink);

    const adapter = new ArtifactDeploymentAdapter({
      layout,
      runner,
      probes: {
        healthUrl: `${baseUrl}/kernel.tar.zst`,
        readinessUrl: `${baseUrl}/kernel.tar.zst`,
        webUrl: `${baseUrl}/kernel.tar.zst`,
      },
      probe: async () => false,
      databaseBackup: false,
      databaseUrl: 'postgresql://test/test',
      verifyTimeoutMs: 20,
      verifyPollMs: 5,
      assertUrl: () => undefined,
    });
    const engine = new UpdateEngine({
      adapter,
      journal: new FileUpdateJournal(layout.journalFile),
      lock: new ExecutorLock({ filePath: layout.lockFile, owner: 'test' }),
      workDir: layout.workDir,
    });
    // 切换后的探针失败 → 回退时探针仍需失败（模拟旧版本也不健康），但至少必须切回。
    const result = await engine.run(localTask(), true);
    expect(result.phase).toBe('recovery_failed');
    expect(await readlink(layout.currentLink)).toBe(previous);
  });

  it('keeps the old release and rolls back when probes fail', async () => {
    const { runner, calls } = fakeTarRunner({
      'kernel.tar.zst': { 'RELEASE.json': releaseJson('kernel') },
      'migrate.tar.zst': {
        'RELEASE.json': releaseJson('migrate'),
        'migrate.mjs': 'process.exit(0)',
      },
    });
    await mkdir(layout.releasesDir, { recursive: true });
    const previous = path.join(layout.releasesDir, '0.2.0');
    await mkdir(previous, { recursive: true });
    await writeFile(path.join(previous, 'RELEASE.json'), releaseJson('kernel', '0.2.0'));
    await symlink(previous, layout.currentLink);

    let healthy = true;
    const adapter = new ArtifactDeploymentAdapter({
      layout,
      runner,
      probes: {
        healthUrl: `${baseUrl}/kernel.tar.zst`,
        readinessUrl: `${baseUrl}/kernel.tar.zst`,
        webUrl: `${baseUrl}/kernel.tar.zst`,
      },
      probe: async () => healthy,
      databaseBackup: false,
      databaseUrl: 'postgresql://test/test',
      verifyTimeoutMs: 50,
      verifyPollMs: 10,
      assertUrl: () => undefined,
    });
    const engine = new UpdateEngine({
      adapter,
      journal: new FileUpdateJournal(layout.journalFile),
      lock: new ExecutorLock({ filePath: layout.lockFile, owner: 'test' }),
      workDir: layout.workDir,
    });
    // 迁移成功后探针失败：应回退到 0.2.0，而不是停留在新版本。
    const original = adapter.verify.bind(adapter);
    adapter.verify = async (ctx) => {
      healthy = false;
      try {
        return await original(ctx);
      } finally {
        healthy = true;
      }
    };
    const result = await engine.run(localTask(), true);
    expect(result, JSON.stringify(result)).toMatchObject({ phase: 'recovered' });
    expect(await readlink(layout.currentLink)).toBe(previous);
    expect(calls.some((call) => call.args.includes('delete'))).toBe(true);
  });

  it('dumps the database before migration when a URL is configured', async () => {
    const { runner, calls } = fakeTarRunner({});
    const adapter = adapterFor(runner);
    const result = await adapter.snapshot({
      task: localTask(),
      targetDigest: '',
      planDigest: 'p',
      workDir: layout.workDir,
    });
    expect(calls.some((call) => call.file === 'pg_dump')).toBe(false);
    // 显式开启备份后才调用 pg_dump，且必须带 --file 与连接串。
    const withBackup = new ArtifactDeploymentAdapter({
      layout,
      runner,
      databaseUrl: 'postgresql://u:p@127.0.0.1:5432/db',
      assertUrl: () => undefined,
    });
    const second = await withBackup.snapshot({
      task: localTask(),
      targetDigest: '',
      planDigest: 'p',
      workDir: layout.workDir,
    });
    const dump = calls.find((call) => call.file === 'pg_dump');
    expect(dump?.args).toEqual(expect.arrayContaining(['--format=custom', '--file']));
    expect(second.backupRef).toContain('backups/');
    void result;
  });

  it('does not restore a snapshot after writes were opened', async () => {
    const { runner, calls } = fakeTarRunner({});
    const adapter = adapterFor(runner);
    const result = await adapter.recover(
      { task: localTask(), targetDigest: '', planDigest: 'p', workDir: layout.workDir },
      { stage: 'verify', detail: 'boom', migrated: true, postWrite: true },
    );
    expect(result.recovered).toBe(false);
    expect(calls.some((call) => call.file === 'pg_restore')).toBe(false);
  });
});
