import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateTask } from '@stackpanel/spec';
import type { CommandRequest, CommandResult, CommandRunner } from '../src/command.ts';
import {
  ComposeDeploymentAdapter,
  ComposeSelfUpdateAdapter,
  DeploymentAdapterError,
  parseDfFreeBytes,
  findImageReference,
  imageOfComposeConfig,
  repositoryOf,
} from '../src/compose-adapter.ts';
import { validateComposeConfig, type ComposeProjectConfig } from '../src/compose-config.ts';
import { FileDeploymentPointer } from '../src/deployment-pointer.ts';
import { FileSnapshotStore } from '../src/snapshot-store.ts';

/** Recording fake runner: matches requests by predicate, returns scripted results. */
function fakeRunner(handler: (req: CommandRequest) => CommandResult | undefined = () => undefined) {
  const calls: CommandRequest[] = [];
  const runner: CommandRunner = {
    async run(req) {
      calls.push(req);
      const scripted = handler(req);
      if (scripted) return scripted;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { runner, calls };
}

const DIGEST = 'sha256:' + 'a'.repeat(64);

function config(overrides: Partial<ComposeProjectConfig> = {}): ComposeProjectConfig {
  return {
    projectName: 'sp',
    projectDir: '/srv/stackpanel',
    composeFiles: ['docker-compose.yml'],
    services: { api: 'api', worker: 'worker', web: 'web', migrate: 'migrate' },
    imageEnv: 'STACKPANEL_IMAGE',
    imageRepository: 'ghcr.io/acme/stackpanel',
    allowedServices: ['api', 'worker', 'web'],
    database: { service: 'postgres', user: 'stackpanel', name: 'stackpanel' },
    // 探针预算收紧到毫秒级：默认预算 180s 会让「探针失败」用例真的等 3 分钟。
    envFile: 'docker/.env',
    probes: {
      readinessUrl: 'http://api:3001/health',
      readyTimeoutMs: 50,
      readyPollIntervalMs: 5,
    },
    ...overrides,
  };
}

function task(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    protocolVersion: 1,
    instanceId: 'sp',
    baselineGeneration: 0,
    targetDigest: DIGEST,
    planDigest: 'plan',
    idempotencyKey: 'k1',
    policyVersion: 1,
    plan: {
      kernel: { version: '0.3.0', digest: DIGEST, migration: 'm1' },
      packages: [],
      planDigestInput: { kernelVersion: '0.3.0', packages: [], frontendAbi: '1', schemaRange: '*' },
    },
    createdAt: '2026-10-17T00:00:00Z',
    ...overrides,
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-adapter-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('compose-config', () => {
  it('rejects incomplete bindings', () => {
    expect(() => validateComposeConfig(config({ imageRepository: '' }))).toThrow(/imageRepository/);
    expect(() => validateComposeConfig(config({ allowedServices: ['api'] }))).toThrow(/受管服务/);
  });

  it('accepts a complete binding', () => {
    expect(validateComposeConfig(config())).toBeDefined();
  });
});

describe('FileDeploymentPointer', () => {
  it('advances generation and remembers the previous digest', async () => {
    const pointer = FileDeploymentPointer.resolve(root);
    expect(await pointer.read()).toBeNull();
    const first = await pointer.advance({
      digest: 'sha256:1',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(first.generation).toBe(1);
    expect(first.previousDigest).toBeNull();
    const second = await pointer.advance({
      digest: 'sha256:2',
      now: new Date('2026-01-02T00:00:00Z'),
    });
    expect(second.generation).toBe(2);
    expect(second.previousDigest).toBe('sha256:1');
  });
});

describe('parseDfFreeBytes', () => {
  it('parses the available column in KB', () => {
    const out = `Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda 100 5 95 5% /`;
    expect(parseDfFreeBytes(out)).toBe(95 * 1024);
  });
});

describe('ComposeDeploymentAdapter', () => {
  function adapterFor(
    handler?: (req: CommandRequest) => CommandResult | undefined,
    overrides: Partial<ComposeProjectConfig> = {},
  ) {
    const { runner, calls } = fakeRunner(handler);
    const probes: string[] = [];
    const adapter = new ComposeDeploymentAdapter({
      config: config(overrides),
      runner,
      stateDir: root,
      probe: async (url) => {
        probes.push(url);
        return true;
      },
      // 默认不发起真实请求：`http://api:3001` 在测试环境不可解析。
      jsonProbe: async () => null,
      now: () => new Date('2026-10-17T00:00:00Z'),
    });
    return { adapter, calls, probes };
  }

  it('downloads the pinned digest image and verifies the local RepoDigest', async () => {
    const { adapter, calls } = adapterFor((req) => {
      if (req.args.includes('image') && req.args.includes('inspect')) {
        return { code: 0, stdout: `ghcr.io/acme/stackpanel@${DIGEST}\n`, stderr: '' };
      }
      return undefined;
    });
    const result = await adapter.download({
      task: task(),
      targetDigest: DIGEST,
      planDigest: 'p',
      workDir: root,
    });
    expect(result.credential).toContain(DIGEST);
    expect(calls.some((c) => c.args[0] === 'pull')).toBe(true);
  });

  it('每条 compose 命令都带 --env-file（否则密钥被插值成空串）', async () => {
    // 真机升级演练抓到的 P0：updater 在容器里跑 docker compose，进程环境里
    // 没有 docker/.env 的 POSTGRES_PASSWORD / JWT_SECRET 等。不带 --env-file 时
    // compose 把 ${POSTGRES_PASSWORD} 插值成空串，up -d 会用空密码重建 postgres，
    // 一次「成功」的升级把实例锁死。
    const { adapter, calls } = adapterFor(undefined, { envFile: 'docker/.env' });
    await adapter.switchTo({
      task: task(),
      targetDigest: DIGEST,
      planDigest: 'p',
      workDir: root,
    });
    const composeCalls = calls.filter((c) => c.args[0] === 'compose');
    expect(composeCalls.length).toBeGreaterThan(0);
    for (const call of composeCalls) {
      const index = call.args.indexOf('--env-file');
      expect(index).toBeGreaterThan(-1);
      expect(call.args[index + 1]).toBe('docker/.env');
      // 必须在 `-f` 与子命令之前，否则 docker compose 会把它当成子命令参数。
      expect(index).toBeLessThan(call.args.indexOf('-f'));
      expect(index).toBeLessThan(call.args.indexOf('up'));
    }
  });

  it('fails download when the pulled digest does not match', async () => {
    const { adapter } = adapterFor((req) => {
      if (req.args.includes('inspect'))
        return { code: 0, stdout: 'ghcr.io/acme/stackpanel@sha256:' + 'b'.repeat(64), stderr: '' };
      return undefined;
    });
    await expect(
      adapter.download({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root }),
    ).rejects.toBeInstanceOf(DeploymentAdapterError);
  });

  it('rejects a stale plan when the generation moved', async () => {
    const pointer = FileDeploymentPointer.resolve(root);
    await pointer.write({
      generation: 5,
      digest: DIGEST,
      previousDigest: null,
      previousGeneration: null,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { adapter } = adapterFor();
    await expect(
      adapter.preflight({
        task: task({ baselineGeneration: 4 }),
        targetDigest: DIGEST,
        planDigest: 'p',
        workDir: root,
      }),
    ).rejects.toThrow(/基线代次/);
  });

  it('fails preflight when free disk is below the floor', async () => {
    const { adapter } = adapterFor(
      (req) =>
        req.file === 'df' ? { code: 0, stdout: 'x 1024 5 9 5% /\n', stderr: '' } : undefined,
      { minFreeBytes: 1024 * 1024 },
    );
    await expect(
      adapter.preflight({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root }),
    ).rejects.toThrow(/磁盘不足/);
  });

  it('quiesces worker and web before snapshot', async () => {
    const { adapter, calls } = adapterFor();
    await adapter.quiesce({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root });
    const stop = calls.find((c) => c.args.includes('stop'));
    expect(stop?.args).toEqual(expect.arrayContaining(['stop', 'worker', 'web']));
  });

  it('snapshots the database to a binary dump and records the ref', async () => {
    const { adapter, calls } = adapterFor();
    const result = await adapter.snapshot({
      task: task(),
      targetDigest: DIGEST,
      planDigest: 'p',
      workDir: root,
    });
    const dump = calls.find((c) => c.args.includes('pg_dump'));
    expect(dump?.stdoutFile).toBeDefined();
    const stored = await FileSnapshotStore.resolve(root).read();
    expect(stored?.ref).toBe(result.backupRef);
  });

  it('switches all managed services to the same target release set', async () => {
    const { adapter, calls } = adapterFor();
    await adapter.switchTo({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root });
    const up = calls.find((c) => c.args.includes('up'));
    expect(up?.env?.['STACKPANEL_IMAGE']).toBe(`ghcr.io/acme/stackpanel@${DIGEST}`);
    expect(up?.args).toEqual(expect.arrayContaining(['api', 'worker', 'web']));
  });

  it('runs migration via the one-shot migrate service on the target image', async () => {
    // 回归：曾经写成 `run api pnpm ... migrate:deploy`，但 api 的 entrypoint 忽略
    // `$@` 并直接起 server，迁移永不执行、命令挂到超时（真机演练抓到）。
    const { adapter, calls } = adapterFor();
    await adapter.migrate({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root });
    const run = calls.find((c) => c.args.includes('run'));
    expect(run?.args).toEqual(expect.arrayContaining(['run', '--rm', '--no-deps']));
    const target = run?.args[run.args.indexOf('--no-deps') + 1];
    expect(target).toBe('migrate');
    expect(run?.args).not.toContain('api');
    expect(run?.args).not.toContain('pnpm');
    expect(run?.env?.['STACKPANEL_IMAGE']).toBe(`ghcr.io/acme/stackpanel@${DIGEST}`);
  });

  it('fails verify when the readiness probe fails', async () => {
    const { runner } = fakeRunner();
    const adapter = new ComposeDeploymentAdapter({
      config: config(),
      runner,
      stateDir: root,
      probe: async () => false,
      jsonProbe: async () => null,
    });
    await expect(
      adapter.verify({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root }),
    ).rejects.toThrow(/readiness/);
  });

  it('fails verify when the running kernel still reports the old version', async () => {
    // `up -d --wait` 只保证容器健康：tag 可复用、compose 也可能复用同名容器。
    const { runner } = fakeRunner();
    const adapter = new ComposeDeploymentAdapter({
      config: config(),
      runner,
      stateDir: root,
      probe: async () => true,
      jsonProbe: async () => ({ status: 200, body: { status: 'ok', version: '0.2.0' } }),
    });
    await expect(
      adapter.verify({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root }),
    ).rejects.toThrow(/内核版本仍是 0\.2\.0/);
  });

  it('accepts verify when the health probe reports the target version', async () => {
    const { runner } = fakeRunner();
    const adapter = new ComposeDeploymentAdapter({
      config: config(),
      runner,
      stateDir: root,
      probe: async () => true,
      jsonProbe: async () => ({ status: 200, body: { status: 'ok', version: '0.3.0' } }),
    });
    const result = await adapter.verify({
      task: task(),
      targetDigest: DIGEST,
      planDigest: 'p',
      workDir: root,
    });
    expect(result.credential).toBe('verify:probes-ok');
  });

  it('keeps polling until the service becomes ready (cold start is not a failure)', async () => {
    // 真机演练抓到：`up -d` 返回时 API 还在启动自检，单次探针必失败，
    // 正常升级会被判失败并回滚；这里要求先失败若干次后转绿仍算成功。
    const { runner } = fakeRunner();
    let attempts = 0;
    const adapter = new ComposeDeploymentAdapter({
      config: config({
        probes: {
          readinessUrl: 'http://api:3001/health',
          readyTimeoutMs: 2_000,
          readyPollIntervalMs: 5,
        },
      }),
      runner,
      stateDir: root,
      probe: async () => {
        attempts += 1;
        return attempts >= 3;
      },
      jsonProbe: async () => ({ status: 200, body: { status: 'ok', version: '0.3.0' } }),
    });
    const result = await adapter.verify({
      task: task(),
      targetDigest: DIGEST,
      planDigest: 'p',
      workDir: root,
    });
    expect(result.credential).toBe('verify:probes-ok');
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it('gives up after the ready budget instead of hanging forever', async () => {
    const { runner } = fakeRunner();
    const adapter = new ComposeDeploymentAdapter({
      config: config({
        probes: {
          readinessUrl: 'http://api:3001/health',
          readyTimeoutMs: 40,
          readyPollIntervalMs: 5,
        },
      }),
      runner,
      stateDir: root,
      probe: async () => false,
      jsonProbe: async () => null,
    });
    await expect(
      adapter.verify({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root }),
    ).rejects.toThrow(/readiness/);
  });

  it('does not fail verify when the health endpoint returns no parseable JSON', async () => {
    const { runner } = fakeRunner();
    const adapter = new ComposeDeploymentAdapter({
      config: config(),
      runner,
      stateDir: root,
      probe: async () => true,
      jsonProbe: async () => ({ status: 200, body: 'ok' }),
    });
    const result = await adapter.verify({
      task: task(),
      targetDigest: DIGEST,
      planDigest: 'p',
      workDir: root,
    });
    expect(result.credential).toBe('verify:probes-ok');
  });

  it('commits by advancing the pointer only after probes pass', async () => {
    const { adapter } = adapterFor();
    const result = await adapter.commit({
      task: task(),
      targetDigest: DIGEST,
      planDigest: 'p',
      workDir: root,
    });
    expect(result.credential).toContain('gen=1');
    expect((await FileDeploymentPointer.resolve(root).read())?.digest).toBe(DIGEST);
  });

  it('never restores an old snapshot after writes opened (postWrite)', async () => {
    const { adapter, calls } = adapterFor();
    const result = await adapter.recover(
      { task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root },
      { stage: 'switchTo', detail: 'boom', migrated: true, postWrite: true },
    );
    expect(result.recovered).toBe(false);
    expect(calls.some((c) => c.args.includes('pg_restore'))).toBe(false);
  });

  it('restores the snapshot when a post-migration (pre-write) failure occurs', async () => {
    const { adapter, calls } = adapterFor();
    await adapter.snapshot({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root });
    const result = await adapter.recover(
      { task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root },
      { stage: 'migrating', detail: 'boom', migrated: true, postWrite: false },
    );
    expect(calls.some((c) => c.args.includes('pg_restore'))).toBe(true);
    expect(result.recovered).toBe(true);
  });

  it('rolls back to the previous digest and advances the pointer generation', async () => {
    const pointer = FileDeploymentPointer.resolve(root);
    await pointer.write({
      generation: 4,
      digest: 'sha256:' + 'b'.repeat(64),
      previousDigest: 'sha256:' + 'c'.repeat(64),
      previousGeneration: 3,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { adapter, calls } = adapterFor((req) =>
      req.args.includes('up') ? { code: 0, stdout: '', stderr: '' } : undefined,
    );
    const result = await adapter.rollbackToPrevious();
    expect(result.ok).toBe(true);
    const up = calls.find((c) => c.args.includes('up'));
    expect(up?.env?.['STACKPANEL_IMAGE']).toBe('sha256:' + 'c'.repeat(64));
    const after = await FileDeploymentPointer.resolve(root).read();
    expect(after?.digest).toBe('sha256:' + 'c'.repeat(64));
    expect(after?.generation).toBe(5);
    // The rolled-back-from generation is preserved for a forward re-roll.
    expect(after?.previousDigest).toBe('sha256:' + 'b'.repeat(64));
  });

  it('refuses to roll back when there is no previous generation', async () => {
    const { adapter, calls } = adapterFor();
    const result = await adapter.rollbackToPrevious();
    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.args.includes('up'))).toBe(false);
  });

  it('reconciles by reading the pointer and probing readiness', async () => {
    const pointer = FileDeploymentPointer.resolve(root);
    await pointer.write({
      generation: 6,
      digest: DIGEST,
      previousDigest: null,
      previousGeneration: null,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { adapter, probes } = adapterFor();
    const result = await adapter.reconcile();
    expect(result.ok).toBe(true);
    expect(result.generation).toBe(6);
    expect(result.digest).toBe(DIGEST);
    expect(probes).toContain('http://api:3001/health');
  });

  it('self-updates the updater service by switching its image env', async () => {
    const { runner, calls } = fakeRunner((req) => {
      if (req.args.includes('images')) {
        return {
          code: 0,
          stdout: JSON.stringify({ Repository: 'ghcr.io/acme/updater', Tag: '1.0.0' }),
          stderr: '',
        };
      }
      if (req.args.includes('image') && req.args.includes('inspect')) {
        return { code: 0, stdout: `ghcr.io/acme/updater@${DIGEST}\n`, stderr: '' };
      }
      return undefined;
    });
    const self = new ComposeSelfUpdateAdapter(config(), runner);
    expect(await self.currentUpdaterImage()).toBe('ghcr.io/acme/updater:1.0.0');
    await self.pullAndVerifyUpdater(DIGEST);
    await self.switchUpdaterTo(DIGEST);
    // 自升级必须落在 **updater 自己的仓库**，不是内核仓库（此前复用 `imageRepository`
    // = 内核仓库，拉取的是内核镜像 → 摘要永远对不上，自升级第一步就失败）。
    const pull = calls.find((c) => c.args[0] === 'pull');
    expect(pull?.args[1]).toBe(`ghcr.io/acme/updater@${DIGEST}`);
    // 切换必须由**独立助手容器**执行：在本容器里 `compose up -d updater` 会在替换
    // 容器时把 CLI 一起杀掉，新容器永远停在 `Created`（真机抓到）。
    const helper = calls.find((c) => c.args[0] === 'run');
    expect(helper).toBeDefined();
    expect(helper?.args).toEqual(expect.arrayContaining(['-d', '--rm']));
    expect(helper?.args).toEqual(
      expect.arrayContaining(['-v', '/var/run/docker.sock:/var/run/docker.sock']),
    );
    expect(helper?.args).toEqual(
      expect.arrayContaining([`${'STACKPANEL_UPDATER_IMAGE'}=ghcr.io/acme/updater@${DIGEST}`]),
    );
    expect(helper?.args).toEqual(expect.arrayContaining(['up', '-d', 'updater']));
    // 助手同样必须带 `--env-file`，否则用默认值插值（`stackpanel-updater:latest`）。
    expect(helper?.args).toEqual(expect.arrayContaining(['--env-file', 'docker/.env']));
    // 助手按**宿主绝对路径**挂载仓库（相对路径在容器内解析错误）。
    expect(helper?.args).toEqual(expect.arrayContaining(['-v', '/srv/stackpanel:/srv/stackpanel']));
  });

  it('uses an explicitly configured updater image repository', async () => {
    const { runner, calls } = fakeRunner((req) => {
      if (req.args.includes('images')) {
        return {
          code: 0,
          stdout: JSON.stringify({ Repository: 'ghcr.io/acme/updater', Tag: '1.0.0' }),
          stderr: '',
        };
      }
      if (req.args.includes('image') && req.args.includes('inspect')) {
        return { code: 0, stdout: `internal.example:5000/stackpanel-updater@${DIGEST}\n`, stderr: '' };
      }
      return undefined;
    });
    const self = new ComposeSelfUpdateAdapter(
      config({ updaterImageRepository: 'internal.example:5000/stackpanel-updater' }),
      runner,
    );
    await self.pullAndVerifyUpdater(DIGEST);
    const pull = calls.find((c) => c.args[0] === 'pull');
    expect(pull?.args[1]).toBe(`internal.example:5000/stackpanel-updater@${DIGEST}`);
  });
});

describe('currentUpdaterImage 优先级', () => {
  /**
   * 真机缺陷：自升级切换只给助手容器注入候选镜像变量，**不改** `docker/.env`。
   * 因此 compose 的声明值仍是旧镜像；若先读声明值，候选启动后的自确认会拿旧引用
   * 与候选摘要比较、永远不匹配 → 计划停在 `switching` → 到点被错误回退。
   */
  it('prefers the running container over the declared compose value', async () => {
    const { runner } = fakeRunner((req) => {
      if (req.args.includes('images')) {
        return {
          code: 0,
          stdout: JSON.stringify([{ Repository: 'ghcr.io/acme/updater', Tag: '2.0.0' }]),
          stderr: '',
        };
      }
      if (req.args.includes('config')) {
        return {
          code: 0,
          stdout: JSON.stringify({ services: { updater: { image: 'ghcr.io/acme/updater:1.0.0' } } }),
          stderr: '',
        };
      }
      return undefined;
    });
    const self = new ComposeSelfUpdateAdapter(config(), runner);
    expect(await self.currentUpdaterImage()).toBe('ghcr.io/acme/updater:2.0.0');
  });

  it('falls back to the declared value when no container is running', async () => {
    const { runner } = fakeRunner((req) => {
      if (req.args.includes('images')) return { code: 0, stdout: '[]', stderr: '' };
      if (req.args.includes('config')) {
        return {
          code: 0,
          stdout: JSON.stringify({ services: { updater: { image: 'ghcr.io/acme/updater:3.0.0' } } }),
          stderr: '',
        };
      }
      return undefined;
    });
    const self = new ComposeSelfUpdateAdapter(config(), runner);
    expect(await self.currentUpdaterImage()).toBe('ghcr.io/acme/updater:3.0.0');
  });
});

describe('imageOfComposeConfig', () => {
  it('reads the declared image for the named service only', () => {
    const out = JSON.stringify({
      services: {
        updater: { image: 'ghcr.io/acme/updater:v3' },
        postgres: { image: 'postgres:16-alpine' },
      },
    });
    expect(imageOfComposeConfig(out, 'updater')).toBe('ghcr.io/acme/updater:v3');
  });

  it('returns null for a missing service or unparsable output', () => {
    expect(imageOfComposeConfig(JSON.stringify({ services: {} }), 'updater')).toBeNull();
    expect(imageOfComposeConfig('not json', 'updater')).toBeNull();
  });
});

describe('findImageReference', () => {
  /**
   * 真机缺陷：compose v5 的 `images --format json` 输出**一个数组**，而解析器只按
   * NDJSON（每行一个对象）处理，于是每一行都解析失败 → 自升级在「读当前 updater
   * 镜像」这一步就抛错，功能整体不可用。
   */
  it('parses the array form emitted by newer compose versions', () => {
    const out = JSON.stringify([
      { Repository: '192.168.64.4:5000/stackpanel-updater', Tag: 'v2', Image: 'x' },
    ]);
    expect(findImageReference(out)).toBe('x');
    expect(
      findImageReference(
        JSON.stringify([{ Repository: 'ghcr.io/acme/updater', Tag: '1.2.3' }]),
      ),
    ).toBe('ghcr.io/acme/updater:1.2.3');
  });

  it('still parses the NDJSON form emitted by older compose versions', () => {
    const out = '{"Repository":"ghcr.io/acme/updater","Tag":"1.0.0"}\n';
    expect(findImageReference(out)).toBe('ghcr.io/acme/updater:1.0.0');
  });

  it('restores a digest tag with @ instead of :', () => {
    const out = JSON.stringify([
      { Repository: 'ghcr.io/acme/updater', Tag: `sha256:${'a'.repeat(64)}` },
    ]);
    expect(findImageReference(out)).toBe(`ghcr.io/acme/updater@sha256:${'a'.repeat(64)}`);
  });

  it('falls back to the image ID when the reference is a digest (empty Tag)', () => {
    // 真机缺陷：digest 引用的镜像 `Tag` 为空，若只拼 `repo:${Tag}` 会得到 `repo:`
    // （无摘要），候选自确认永远匹配不上。
    const out = JSON.stringify([
      { Repository: '192.168.64.4:5000/stackpanel-updater', Tag: '', ID: DIGEST },
    ]);
    expect(findImageReference(out)).toBe(`192.168.64.4:5000/stackpanel-updater@${DIGEST}`);
  });

  it('returns null for empty or unusable output', () => {
    expect(findImageReference('')).toBeNull();
    expect(findImageReference('no such service')).toBeNull();
    expect(findImageReference('[]')).toBeNull();
  });
});

describe('repositoryOf', () => {
  it('strips a tag but keeps a registry port', () => {
    expect(repositoryOf('192.168.64.4:5000/stackpanel-updater:v2')).toBe(
      '192.168.64.4:5000/stackpanel-updater',
    );
  });

  it('strips a digest reference', () => {
    expect(repositoryOf(`ghcr.io/acme/updater@${DIGEST}`)).toBe('ghcr.io/acme/updater');
  });

  it('returns the reference unchanged when it has neither tag nor digest', () => {
    expect(repositoryOf('ghcr.io/acme/updater')).toBe('ghcr.io/acme/updater');
  });
});
