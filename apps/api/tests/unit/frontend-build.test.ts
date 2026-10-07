import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeRedis, getRedis, pingRedis } from '@stackpanel/db';
import {
  FrontendBuilder,
  frontendBuildChannel,
  runFrontendBuild,
  type FrontendCommandRunner,
} from '../../src/lib/frontend-build.ts';
import { frontendApplySteps } from '../../src/lib/frontend-apply.ts';
/**
 * Frontend build orchestration (S7 / ADR-0017 §5).
 *
 * The worker is the single builder: it consumes the durable request file the
 * API writes, runs the build exactly once, and publishes a new signature. Web
 * replicas never build. This suite exercises the builder loop (durable poll +
 * Redis nudge) with the build runner stubbed out.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const redis = await (async () => {
  try {
    const client = await getRedis(REDIS_URL);
    return (await pingRedis()) ? client : null;
  } catch {
    return null;
  }
})();

afterAll(async () => {
  await closeRedis();
});

const originalDataDir = process.env['STACKPANEL_DATA_DIR'];
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env['STACKPANEL_DATA_DIR'];
  else process.env['STACKPANEL_DATA_DIR'] = originalDataDir;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-frontend-build-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'plugins'), { recursive: true });
  process.env['STACKPANEL_DATA_DIR'] = dir;
  return dir;
}

async function writeRequest(dir: string, reason: string): Promise<void> {
  await writeFile(
    path.join(dir, 'frontend-apply.request.json'),
    JSON.stringify({
      requestedAt: new Date().toISOString(),
      requestedBy: null,
      reason,
      target: 'plugin',
      action: 'install',
      rebuild: true,
      label: 'Demo',
      steps: ['停止当前服务', '编译插件前端资源', '生成前端产物', '重启服务'],
    }),
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('FrontendBuilder', () => {
  it('builds a pending request exactly once, then idles', async () => {
    const dir = await makeDataDir();
    await writeRequest(dir, 'plugin.install');
    const calls: string[] = [];
    const builder = new FrontendBuilder({
      redis: null,
      intervalMs: 20,
      logger: { info: () => undefined, warn: () => undefined },
      runBuild: async (request) => {
        calls.push(request.reason);
        // Simulate the real builder consuming the request file.
        await rm(path.join(dir, 'frontend-apply.request.json'), { force: true });
      },
    });
    builder.start();
    try {
      await waitFor(() => calls.length >= 1);
      const count = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(calls).toEqual(['plugin.install']);
      expect(calls.length).toBe(count);
    } finally {
      await builder.stop();
    }
  });

  it('does not build when no request is pending', async () => {
    await makeDataDir();
    const calls: string[] = [];
    const builder = new FrontendBuilder({
      redis: null,
      intervalMs: 20,
      logger: { info: () => undefined, warn: () => undefined },
      runBuild: async (request) => void calls.push(request.reason),
    });
    builder.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(calls).toHaveLength(0);
    } finally {
      await builder.stop();
    }
  });

  it('is a no-op when STACKPANEL_FRONTEND_AUTOBUILD=0', async () => {
    const dir = await makeDataDir();
    await writeRequest(dir, 'plugin.install');
    const previous = process.env['STACKPANEL_FRONTEND_AUTOBUILD'];
    process.env['STACKPANEL_FRONTEND_AUTOBUILD'] = '0';
    const calls: string[] = [];
    const builder = new FrontendBuilder({
      redis: null,
      intervalMs: 20,
      logger: { info: () => undefined, warn: () => undefined },
      runBuild: async (request) => void calls.push(request.reason),
    });
    builder.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(calls).toHaveLength(0);
    } finally {
      await builder.stop();
      if (previous === undefined) delete process.env['STACKPANEL_FRONTEND_AUTOBUILD'];
      else process.env['STACKPANEL_FRONTEND_AUTOBUILD'] = previous;
    }
  });
});

describe.skipIf(!redis)('FrontendBuilder (redis nudge)', () => {
  it('reacts to a Pub/Sub nudge by draining the durable request', async () => {
    const dir = await makeDataDir();
    const calls: string[] = [];
    const client = redis;
    if (!client) throw new Error('redis unavailable');
    const builder = new FrontendBuilder({
      redis: client,
      intervalMs: 10_000, // rely on the nudge, not the poll
      logger: { info: () => undefined, warn: () => undefined },
      runBuild: async (request) => {
        calls.push(request.reason);
        await rm(path.join(dir, 'frontend-apply.request.json'), { force: true });
      },
    });
    builder.start();
    try {
      // Give the subscriber time to attach, then write the durable request and
      // broadcast the pending nudge.
      await new Promise((resolve) => setTimeout(resolve, 40));
      await writeRequest(dir, 'theme.install');
      await client.publish(frontendBuildChannel(), 'pending');
      await waitFor(() => calls.length >= 1);
      expect(calls).toEqual(['theme.install']);
    } finally {
      await builder.stop();
    }
  });
});

describe('runFrontendBuild', () => {
  it('dev apply steps omit service stop/restart', () => {
    expect(frontendApplySteps({ target: 'plugin', action: 'remove', rebuild: true, dev: true })).toEqual([
      '移除插件前端资源',
      '生成前端产物',
    ]);
    expect(frontendApplySteps({ target: 'plugin', action: 'remove', rebuild: true, dev: false })).toEqual([
      '停止当前服务',
      '移除插件前端资源',
      '生成前端产物',
      '重启服务',
    ]);
  });

  it('in dev only regenerates the frontend registry (no next build)', async () => {
    const dir = await makeDataDir();
    const commands: string[] = [];
    const runner: FrontendCommandRunner = async (command, args) => {
      commands.push([command, ...args].join(' '));
      return { code: 0 };
    };
    await runFrontendBuild(
      {
        requestedAt: new Date().toISOString(),
        requestedBy: null,
        reason: 'plugin.install',
        target: 'plugin',
        action: 'install',
        rebuild: true,
      },
      { runCommand: runner, dev: true },
    );
    expect(commands).toEqual(['pnpm build:frontend']);
    // The request is consumed so the admin banner clears.
    await expect(
      readFileSafe(path.join(dir, 'frontend-apply.request.json')),
    ).resolves.toBeNull();
  });

  it('in production also builds the Next bundle', async () => {
    await makeDataDir();
    const commands: string[] = [];
    const runner: FrontendCommandRunner = async (command, args) => {
      commands.push([command, ...args].join(' '));
      return { code: 0 };
    };
    await runFrontendBuild(
      {
        requestedAt: new Date().toISOString(),
        requestedBy: null,
        reason: 'plugin.install',
        target: 'plugin',
        action: 'install',
        rebuild: true,
      },
      { runCommand: runner, dev: false },
    );
    expect(commands).toEqual([
      'pnpm build:frontend',
      'pnpm --filter @stackpanel/web build',
    ]);
  });

  it('reports failure and keeps the request cleared without a signature', async () => {
    const dir = await makeDataDir();
    const runner: FrontendCommandRunner = async () => ({ code: 1 });
    await runFrontendBuild(
      {
        requestedAt: new Date().toISOString(),
        requestedBy: null,
        reason: 'plugin.install',
        target: 'plugin',
        action: 'install',
        rebuild: true,
      },
      { runCommand: runner, dev: true },
    );
    const status = JSON.parse(
      (await readFileSafe(path.join(dir, 'frontend-apply.status.json'))) ?? '{}',
    ) as { state?: string; message?: string };
    expect(status.state).toBe('failed');
    expect(status.message).toContain('前端资源编译失败');
  });
});

async function readFileSafe(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}
